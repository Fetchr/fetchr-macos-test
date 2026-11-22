import sys, struct, ctypes
from ctypes import wintypes
sys.path.insert(0, r'C:\Users\h3r0n\Documents\yt-dlp\stream-cutter\src-tauri')
from check_dll_imports import parse_pe

RT_MANIFEST = 24
CREATEPROCESS_MANIFEST_RESOURCE_ID = 1

def extract_manifest(path):
    data, dirs, rva2off, is64 = parse_pe(path)
    rva, sz = dirs[2]
    if not rva:
        return None
    root = rva2off(rva)
    result = []

    def data_entry(lang_off):
        va, size, cp, _ = struct.unpack_from('<IIII', data, lang_off)
        moff = rva2off(va)
        return data[moff:moff + size]

    def walk(off, baseoff, depth, typeid):
        _, _, _, _, n_named, n_id = struct.unpack_from('<IIIIHH', data, off)
        for i in range(n_named + n_id):
            nm, val = struct.unpack_from('<II', data, off + 16 + i * 8)
            rid = nm & 0xFFFF if not (nm & 0x80000000) else None
            if depth == 0:
                if rid == RT_MANIFEST and (val & 0x80000000):
                    walk(baseoff + (val & 0x7FFFFFFF), baseoff, depth + 1, rid)
            elif val & 0x80000000:
                walk(baseoff + (val & 0x7FFFFFFF), baseoff, depth + 1, typeid)
            else:
                result.append(data_entry(baseoff + val))

    walk(root, root, 0, None)
    return result[0] if result else None

def embed_manifest(target, manifest_bytes):
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    BeginUpdateResourceW = kernel32.BeginUpdateResourceW
    BeginUpdateResourceW.restype = wintypes.HANDLE
    BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    UpdateResourceW = kernel32.UpdateResourceW
    UpdateResourceW.restype = wintypes.BOOL
    UpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    EndUpdateResourceW = kernel32.EndUpdateResourceW
    EndUpdateResourceW.restype = wintypes.BOOL
    EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]

    handle = BeginUpdateResourceW(target, False)
    if not handle:
        raise OSError('BeginUpdateResource failed', ctypes.get_last_error())
    buf = ctypes.create_string_buffer(manifest_bytes, len(manifest_bytes))
    ok = UpdateResourceW(handle, RT_MANIFEST, CREATEPROCESS_MANIFEST_RESOURCE_ID, 0x0409, buf, len(manifest_bytes))
    if not ok:
        EndUpdateResourceW(handle, True)
        raise OSError('UpdateResource failed', ctypes.get_last_error())
    if not EndUpdateResourceW(handle, False):
        raise OSError('EndUpdateResource failed', ctypes.get_last_error())

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    manifest = extract_manifest(src)
    if not manifest:
        print('NO MANIFEST in', src)
        sys.exit(1)
    embed_manifest(dst, manifest)
    print('manifest embedded:', len(manifest), 'bytes ->', dst.rsplit(chr(92), 1)[-1])
