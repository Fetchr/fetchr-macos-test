import struct, sys, os

def parse_pe(path):
    data = open(path, 'rb').read()
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    assert data[pe:pe+4] == b'PE\0\0'
    coff = pe + 4
    machine, nsec, _, _, _, optsize, _ = struct.unpack_from('<HHIIIHH', data, coff)
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    is64 = magic == 0x20B
    # data directories
    dd_off = opt + (112 if is64 else 96)
    dirs = []
    for i in range(16):
        va, sz = struct.unpack_from('<II', data, dd_off + i*8)
        dirs.append((va, sz))
    secs = []
    soff = opt + optsize
    for i in range(nsec):
        name = data[soff+i*40:soff+i*40+8].rstrip(b'\0').decode('ascii', 'replace')
        vsz, va, rsz, rptr = struct.unpack_from('<IIII', data, soff+i*40+8)
        secs.append((name, va, vsz, rptr, rsz))
    def rva2off(rva):
        for name, va, vsz, rptr, rsz in secs:
            if va <= rva < va + max(vsz, rsz):
                return rptr + (rva - va)
        return None
    return data, dirs, rva2off, is64

def imports(path):
    data, dirs, rva2off, is64 = parse_pe(path)
    imp_va, imp_sz = dirs[1]
    out = {}
    if not imp_va:
        return out
    off = rva2off(imp_va)
    while True:
        oft, ts, fwd, name_rva, ft = struct.unpack_from('<IIIII', data, off)
        if name_rva == 0:
            break
        noff = rva2off(name_rva)
        dll = data[noff:data.index(b'\0', noff)].decode('ascii', 'replace')
        funcs = []
        thunk_rva = oft or ft
        toff = rva2off(thunk_rva)
        fmt, size = ('<Q', 8) if is64 else ('<I', 4)
        ordflag = 0x8000000000000000 if is64 else 0x80000000
        while True:
            val = struct.unpack_from(fmt, data, toff)[0]
            if val == 0:
                break
            if not (val & ordflag):
                hoff = rva2off(val)
                fname = data[hoff+2:data.index(b'\0', hoff+2)].decode('ascii', 'replace')
                funcs.append(fname)
            toff += size
        out[dll.lower()] = funcs
        off += 20
    return out

def exports(path):
    data, dirs, rva2off, is64 = parse_pe(path)
    exp_va, exp_sz = dirs[0]
    names = set()
    if not exp_va:
        return names
    off = rva2off(exp_va)
    fields = struct.unpack_from('<IIHHIIIIIII', data, off)
    n_names = fields[7]
    names_rva = fields[9]
    noff = rva2off(names_rva)
    for i in range(n_names):
        nrva = struct.unpack_from('<I', data, noff + i*4)[0]
        noff2 = rva2off(nrva)
        names.add(data[noff2:data.index(b'\0', noff2)].decode('ascii', 'replace'))
    return names

exe = sys.argv[1] if len(sys.argv) > 1 else ''
if exe:
    exe_dir = os.path.dirname(os.path.abspath(exe))
    search = [exe_dir, r'C:\Windows\System32', r'C:\Windows']
    env_path = os.environ.get('PATH', '').split(os.pathsep)
    search += [p for p in env_path if p]

    for dll, funcs in imports(exe).items():
        resolved = None
        for d in search:
            cand = os.path.join(d, dll)
            if os.path.isfile(cand):
                resolved = cand
                break
        if not resolved:
            print(f'MISSING DLL: {dll} ({len(funcs)} imports)')
            continue
        try:
            ex = exports(resolved)
        except Exception as e:
            print(f'UNREADABLE: {resolved}: {e}')
            continue
        missing = [f for f in funcs if f not in ex]
        if missing:
            print(f'BAD DLL: {resolved}')
            print(f'  missing exports ({len(missing)}/{len(funcs)}): {missing[:10]}')
        else:
            print(f'OK: {dll} -> {resolved}')
