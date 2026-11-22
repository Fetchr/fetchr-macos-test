import { useEffect, useState } from "react";

import { ipc, type VpsCredentials } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ConfirmModal } from "./ConfirmModal";
import { fmtBytes } from "./format";
import styles from "./VpsRecorderPage.module.css";

type AuthMode = "password" | "key";

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^\[?[0-9a-f:.]+\]?$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

function hostLooksValid(value: string): boolean {
  const host = value.trim();
  if (!host) return false;
  if (/^[\d.]+$/.test(host)) return IPV4.test(host);
  if (host.includes(":")) return IPV6.test(host);
  return host.toLowerCase() === "localhost" || DOMAIN.test(host);
}

function parsePort(value: string): number | null {
  const port = Number(value);
  return value !== "" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Adds a server: IP, port, login, password → Enter. The app installs the agent
 * over SSH and keeps a tunnel to it; the password goes to the OS credential
 * store, never to a config file, and is dropped from this form on success.
 */
export function VpsConnectPanel() {
  const config = useVpsRecorderStore((s) => s.config);
  const preflight = useVpsRecorderStore((s) => s.preflight);
  const authMethods = useVpsRecorderStore((s) => s.authMethods);
  const probeAuthMethods = useVpsRecorderStore((s) => s.probeAuthMethods);
  const provisionLog = useVpsRecorderStore((s) => s.provisionLog);
  const connectError = useVpsRecorderStore((s) => s.connectError);
  const connectErrorDetail = useVpsRecorderStore((s) => s.connectErrorDetail);
  const busy = useVpsRecorderStore((s) => s.busy);
  const provisionFailed = useVpsRecorderStore((s) => s.provisionFailed);
  const runPreflight = useVpsRecorderStore((s) => s.runPreflight);
  const provision = useVpsRecorderStore((s) => s.provision);
  const forget = useVpsRecorderStore((s) => s.forget);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<AuthMode>("password");
  const [keyPath, setKeyPath] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const [copied, setCopied] = useState(false);

  const hostValid = hostLooksValid(host);
  const parsedPort = parsePort(port);
  const hostError = host.trim() && !hostValid ? "Похоже, это не IP-адрес и не домен." : null;
  const portError = parsedPort == null ? "Порт — число от 1 до 65535 (обычно 22)." : null;

  useEffect(() => {
    if (!config.host) return;
    setHost(config.host);
    setPort(String(config.ssh_port));
    setUser(config.user);
    if (config.key_path) {
      setKeyPath(config.key_path);
      setMode("key");
    }
  }, [config.host, config.ssh_port, config.user, config.key_path]);

  // Ask the server what it accepts as soon as the address is typed. No secret
  // is sent, and it turns "wrong password" into "this server wants a key".
  // Debounced, and only for an address that can be right: a half-typed host
  // or port must not knock on servers (fail2ban counts those too).
  useEffect(() => {
    const trimmed = host.trim();
    const trimmedUser = user.trim();
    if (!hostValid || parsedPort == null || !trimmedUser) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      void probeAuthMethods(trimmed, parsedPort, trimmedUser).then((methods) => {
        if (!stale && methods && !methods.password && methods.key) setMode("key");
      });
    }, 900);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [host, hostValid, parsedPort, user, probeAuthMethods]);

  const credentials = (): VpsCredentials | null => {
    const trimmedHost = host.trim();
    if (!hostValid || !user.trim() || parsedPort == null) return null;
    if (mode === "key" ? !keyPath.trim() : !password) return null;
    return {
      host: trimmedHost,
      port: parsedPort,
      user: user.trim(),
      password,
      keyPath: mode === "key" ? keyPath.trim() : null,
    };
  };

  const working = busy.provision || busy.preflight;

  const handleConnect = async () => {
    const creds = credentials();
    if (!creds || working) return;
    if (await provision(creds)) setPassword("");
  };

  const handleForget = async () => {
    setConfirmForget(false);
    setPassword("");
    await forget();
  };

  const copyLog = async () => {
    const text = [...provisionLog, ...(connectErrorDetail ? [`Ошибка: ${connectErrorDetail}`] : [])].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className={styles.panel}>
      <div>
        <h2 className={styles.panelTitle}>Подключение к серверу</h2>
        <p className={styles.panelHelp}>
          Введите адрес и пароль от VPS — их присылает хостинг. Fetchr сам установит на сервер
          всё нужное для записи и подключится к нему по защищённому каналу. Пароль хранится
          в защищённом хранилище Windows.
        </p>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Способ входа">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "password"}
          className={cn(styles.tab, mode === "password" && styles.tabActive)}
          onClick={() => setMode("password")}
        >
          Пароль
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "key"}
          className={cn(styles.tab, mode === "key" && styles.tabActive)}
          onClick={() => setMode("key")}
        >
          SSH-ключ
        </button>
      </div>

      <form
        className={styles.formGrid}
        onSubmit={(event) => {
          event.preventDefault();
          void handleConnect();
        }}
      >
        {/* Enter in any field submits; a form needs a submit control for that. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <label className={styles.field}>
          <span className={styles.fieldLabel}>IP или домен</span>
          <input
            className={styles.input}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="203.0.113.10"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(hostError)}
          />
          {hostError && <span className={styles.fieldError}>{hostError}</span>}
        </label>
        <label className={styles.field} title="Порт, через который Fetchr входит на сервер. Его присылает хостинг, обычно 22.">
          <span className={styles.fieldLabel}>Порт для входа (SSH)</span>
          <input
            className={styles.input}
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
            placeholder="22"
            inputMode="numeric"
            aria-invalid={Boolean(portError)}
          />
          {portError && <span className={styles.fieldError}>{portError}</span>}
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Пользователь</span>
          <input
            className={styles.input}
            value={user}
            onChange={(event) => setUser(event.target.value)}
            placeholder="root"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            {mode === "key" ? "Пароль ключа (если есть)" : "Пароль"}
          </span>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
          />
        </label>
      </form>

      {mode === "key" && (
        <div className={styles.rangeRow}>
          <input
            className={styles.input}
            value={keyPath}
            onChange={(event) => setKeyPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleConnect();
            }}
            placeholder="C:\Users\...\.ssh\id_ed25519"
            spellCheck={false}
            aria-label="Путь к приватному ключу"
          />
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => void ipc.chooseSshKeyFile().then((path) => path && setKeyPath(path))}
          >
            <RedesignIcon name="folder" />
            Выбрать
          </button>
        </div>
      )}

      {authMethods && (
        <div
          className={authMethods.password || authMethods.key ? styles.noticeBox : styles.errorBox}
          title={`Способы входа: ${authMethods.methods.join(", ") || "—"}`}
        >
          <RedesignIcon name={authMethods.password ? "info" : "key"} />
          <div className={styles.noticeText}>
            {authMethods.password
              ? "Сервер найден, вход по паролю разрешён."
              : authMethods.key
                ? "Этот сервер не принимает пароль — нужен SSH-ключ."
                : "Сервер найден, но не разрешает ни пароль, ни ключ."}
            {!authMethods.password && authMethods.key && (
              <details className={styles.details}>
                <summary>Как разрешить вход по паролю</summary>
                В <span className={styles.mono}>/etc/ssh/sshd_config.d/*.conf</span> и{" "}
                <span className={styles.mono}>/etc/ssh/sshd_config</span> поставьте{" "}
                <span className={styles.mono}>PasswordAuthentication yes</span> и{" "}
                <span className={styles.mono}>PermitRootLogin yes</span>, затем выполните{" "}
                <span className={styles.mono}>systemctl restart ssh</span>.
              </details>
            )}
          </div>
        </div>
      )}

      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!credentials() || working}
          onClick={() => void handleConnect()}
          aria-busy={busy.provision}
        >
          <RedesignIcon
            name={busy.provision ? "loading" : "secure"}
            className={busy.provision ? styles.spinning : undefined}
          />
          {busy.provision ? "Настраиваю сервер…" : "Подключить и настроить"}
        </button>
        <button
          type="button"
          className={styles.ghostButton}
          disabled={!credentials() || working}
          onClick={() => {
            const creds = credentials();
            if (creds) void runPreflight(creds);
          }}
          aria-busy={busy.preflight}
        >
          <RedesignIcon
            name={busy.preflight ? "loading" : "status"}
            className={busy.preflight ? styles.spinning : undefined}
          />
          Проверить сервер
        </button>
        {config.host && (
          <button type="button" className={styles.dangerButton} onClick={() => setConfirmForget(true)}>
            <RedesignIcon name="trash" />
            Забыть сервер
          </button>
        )}
      </div>

      <ConfirmModal
        open={confirmForget}
        title="Забыть этот сервер?"
        confirmLabel="Забыть сервер"
        onCancel={() => setConfirmForget(false)}
        onConfirm={() => void handleForget()}
      >
        Fetchr удалит с этого компьютера адрес, логин и пароль сервера {config.host} и отключится от него.
        Записи, клипы и слежение за каналами останутся на сервере и продолжат работать. Чтобы снова
        их увидеть, подключите сервер заново.
      </ConfirmModal>

      {connectError && (
        <div className={styles.errorBox} role="alert">
          <RedesignIcon name="alert" />
          <div className={styles.noticeText}>
            {connectError}
            {connectErrorDetail && connectErrorDetail !== connectError && (
              <details className={styles.details}>
                <summary>Подробнее</summary>
                <span className={styles.mono}>{connectErrorDetail}</span>
              </details>
            )}
          </div>
          {credentials() && (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={working}
              onClick={() => void handleConnect()}
            >
              Повторить
            </button>
          )}
        </div>
      )}

      {preflight && (
        <div className={styles.noticeBox}>
          <RedesignIcon name="info" />
          <div className={styles.noticeText}>
            Сервер доступен. Свободно на диске:{" "}
            <span className={styles.mono}>
              {fmtBytes(preflight.disk_free)} из {fmtBytes(preflight.disk_total)}
            </span>
            <br />
            {preflight.missing.length > 0
              ? "При подключении Fetchr доустановит недостающие программы."
              : "Всё необходимое уже установлено."}
            <details className={styles.details}>
              <summary>Система и ключ сервера</summary>
              {preflight.os || "Linux"} · {preflight.arch}
              <br />
              <span title="Уникальный «паспорт» сервера. Fetchr запоминает его и остановит подключение, если он вдруг изменится — так видна подмена сервера.">
                Отпечаток ключа сервера:
              </span>{" "}
              <span className={styles.mono}>{preflight.host_key_fingerprint}</span>
              {preflight.missing.length > 0 && (
                <>
                  <br />
                  Будет установлено: {preflight.missing.join(", ")}
                </>
              )}
            </details>
          </div>
        </div>
      )}

      {provisionLog.length > 0 && (
        <>
          <ul className={styles.log} aria-live="polite">
            {provisionLog.map((line, index) => {
              const last = index === provisionLog.length - 1;
              const failed = last && provisionFailed && !busy.provision;
              const mark = last && busy.provision ? "… " : failed ? "✗ " : "✓ ";
              return (
                <li key={`${index}:${line}`} className={failed ? styles.logFailed : undefined}>
                  {mark}
                  {line}
                </li>
              );
            })}
          </ul>
          {!busy.provision && (
            <div className={styles.buttonRow}>
              <button type="button" className={styles.ghostButton} onClick={() => void copyLog()}>
                <RedesignIcon name={copied ? "check" : "copy"} />
                {copied ? "Скопировано" : "Скопировать лог"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
