import sys
sys.path.insert(0, r'C:\Users\h3r0n\Documents\yt-dlp\stream-cutter\src-tauri')
from check_dll_imports import parse_pe
import struct
base = r'C:\Users\h3r0n\Documents\yt-dlp\stream-cutter\src-tauri\target\debug\deps'
for path in (base + r'\fetchr_lib-3a5b7446d417cedd.exe', base + r'\fetchr-57475e72d4416465.exe'):
    data, dirs, rva2off, is64 = parse_pe(path)
    rva, sz = dirs[2]
    manifests = []
    if rva:
        root = rva2off(rva)

        def data_entry(lang_off):
            va, size, cp, _ = struct.unpack_from('<IIII', data, lang_off)
            moff = rva2off(va)
            return data[moff:moff + size].decode('utf-8', 'replace')

        def walk_names(off, baseoff, typeid):
            _, _, _, _, n_named, n_id = struct.unpack_from('<IIIIHH', data, off)
            for i in range(n_named + n_id):
                nm, val = struct.unpack_from('<II', data, off + 16 + i * 8)
                if val & 0x80000000:
                    walk_names(baseoff + (val & 0x7FFFFFFF), baseoff, typeid)
                else:
                    manifests.append(data_entry(baseoff + val))

        def walk_types(off, baseoff):
            _, _, _, _, n_named, n_id = struct.unpack_from('<IIIIHH', data, off)
            for i in range(n_named + n_id):
                nm, val = struct.unpack_from('<II', data, off + 16 + i * 8)
                rid = nm & 0xFFFF if not (nm & 0x80000000) else -1
                if rid == 24 and (val & 0x80000000):
                    walk_names(baseoff + (val & 0x7FFFFFFF), baseoff, rid)

        walk_types(root, root)
    short = path.rsplit('\\', 1)[-1]
    print(short, '-> manifest:', 'YES' if manifests else 'NO')
    if manifests:
        print(manifests[0][:500])
    print('---')
