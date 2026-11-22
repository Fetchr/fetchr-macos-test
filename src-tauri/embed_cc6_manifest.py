import sys, ctypes
from ctypes import wintypes

MANIFEST = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">system</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"""

RT_MANIFEST = 24
CREATEPROCESS_MANIFEST_RESOURCE_ID = 1

def embed_manifest(target, manifest_bytes=MANIFEST):
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
    ok = UpdateResourceW(handle, ctypes.wintypes.LPCWSTR(RT_MANIFEST), ctypes.wintypes.LPCWSTR(CREATEPROCESS_MANIFEST_RESOURCE_ID), 0x0409, buf, len(manifest_bytes))
    if not ok:
        EndUpdateResourceW(handle, True)
        raise OSError('UpdateResource failed', ctypes.get_last_error())
    if not EndUpdateResourceW(handle, False):
        raise OSError('EndUpdateResource failed', ctypes.get_last_error())

if __name__ == '__main__':
    embed_manifest(sys.argv[1])
    print('manifest embedded ->', sys.argv[1].rsplit(chr(92), 1)[-1])
