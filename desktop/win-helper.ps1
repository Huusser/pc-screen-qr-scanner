# win-helper.ps1 -- Windows input/window helper for the QR tool
#
# Design notes (keep this file ASCII-only: PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, so any non-ASCII literal would be garbled on some
# machines. All user-facing Chinese text lives on the Node side.)
#
# Two ways to run this file. Both share the exact same action bodies below.
#
#   one-shot   powershell -File win-helper.ps1 -Action keys -Keys ... -WaitMs ...
#              Every call pays process start + script parse + the Add-Type
#              compile of the C# block (400~500ms before the action begins)
#              and again 450~500ms after it replies (module unload + exit).
#              Four actions per handover => 40% of the end-to-end time was
#              this, not the work itself.
#
#   resident   powershell -File win-helper.ps1 -Serve
#              One JSON request per line on stdin, one JSON reply per line on
#              stdout, forever. The cost above is paid once, while the user is
#              still scanning the QR code. Request: {"id":3,"a":"keys",
#              "o":{"wait":1500,"pids":"1,2","win":133400}}.
#
# One-shot mode is not legacy: it is the fallback path (QRSCAN_WORKER=0) AND
# the way a human runs a single action by hand while debugging.
#
# Things to know about the resident mode:
#   - closing stdin IS the shutdown signal; there is no other. Node closes it
#     on quit, so the process cannot outlive the app.
#   - it is a single point of failure (a one-shot process cannot poison the
#     next call), so Node treats a missed deadline as "kill and restart", and
#     gives up after two consecutive restarts instead of retrying forever.
#   - every request resets the option variables to their defaults first, so a
#     field missing from request N can never inherit request N-1's value.
#   - reads/writes go through explicit UTF-8 StreamReader/StreamWriter instead
#     of [Console]::OutputEncoding, because window titles are Chinese and the
#     console code page depends on the machine.
#
# DPI: this process is DPI-unaware, so GetWindowRect / CopyFromScreen /
# SetCursorPos all speak the same virtualized coordinate space. Consistency
# matters more than absolute accuracy here -- we never mix with physical pixels
# measured somewhere else.

param(
  # Not Mandatory: -Serve mode takes its actions from stdin instead.
  [string]$Action = "",
  [string]$Out = "",
  [int]$WaitMs = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Keys = "",
  [string]$Target = "",     # base64(UTF8) needle for uiafind / ocr (never raw text: keep file ASCII)
  [int]$TargetPid = 0,      # single pid, kept for older callers
  [string]$Pids = "",       # comma-separated pids of the whole WeChat process family
  [string]$File = "",       # PNG file the ocr action should read
  [int]$Hwnd = 0,           # specific top-level window for the shot action
  [int]$Win = 0,            # specific top-level window to type into / click inside
  [int]$PollMs = 4000,      # how long to watch for "did the click do anything"
  [switch]$Full,            # wxprobe: also resolve process NAMES for each pid
                            # (diagnostics only -- ~190ms for 18 pids, so it is
                            # off by default and only the test harness asks)
  [bool]$Ready = $true,     # keys: poll for "the result page has appeared"
                            # instead of sleeping WaitMs outright. false = the
                            # old blind sleep (QRSCAN_READY=0, for A/B and as
                            # the one-key rollback of the third batch)
  [switch]$Serve            # resident worker: read JSON requests from stdin
                            # until stdin closes (see the header notes)
)

$ErrorActionPreference = "Stop"

# Which of the two run modes are we in? Kept as a script-scope bool so the
# helpers below (Use-Request, Emit) can branch on it without a parameter on
# every call. NOTE: these names must stay clear of the parameter names above --
# PowerShell variable names are case-insensitive, so e.g. $Out and $OUT are the
# same variable (that trap already cost one debugging session, see "click").
$script:SERVE = [bool]$Serve
$script:PIPE_IN = $null       # stdin  StreamReader (resident mode only)
$script:PIPE_OUT = $null      # stdout StreamWriter (resident mode only)
$script:REQ_ID = $null        # id of the request being served (echoed back)
$script:WORKER_START = 0      # ms from process start to the serve loop ready

# ---- timing instrumentation (temporary, safe to delete) ----
# The time spent *before* the action does its work (process start + script
# parse + CodeDom compile of the C# block) used to be paid on every single
# call. $BOOT measures exactly that, and every Emit() reports it as "bootMs",
# so the JS side can split each call into "boot" vs "work" instead of guessing.
# In resident mode the clock is restarted per request instead, which turns
# bootMs into "request dispatch" (a few ms) and keeps "work" comparable.
# Delete this line together with the $BOOT assignment and the injection in
# Emit() when the timing instrumentation is removed.
$SW = [System.Diagnostics.Stopwatch]::StartNew()

# Window titles are Chinese: without UTF-8 on the way out, ConvertTo-Json text
# is written in the OEM code page and arrives at Node as mojibake, so matching
# "WeChat" by title silently fails.
#
# Resident mode does not rely on this setting at all: it wraps the raw standard
# streams in explicit UTF-8 readers/writers below, because the console code
# page depends on the machine and a pipe has no console at all.
$UTF8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $UTF8 } catch { }
try { [Console]::InputEncoding = $UTF8 } catch { }
try { $OutputEncoding = $UTF8 } catch { }

if ($script:SERVE) {
  $script:PIPE_IN = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $UTF8)
  $script:PIPE_OUT = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $UTF8)
  $script:PIPE_OUT.AutoFlush = $true   # Node waits for a line, never for a close
}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class QrWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern int SetStretchBltMode(IntPtr hdc, int mode);
  [DllImport("gdi32.dll")] public static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh,
    IntPtr src, int sx, int sy, int sw, int sh, uint rop);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines,
    IntPtr bits, ref BITMAPINFO bmi, uint usage);

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight;
    public ushort biPlanes; public ushort biBitCount; public uint biCompression;
    public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO {
    public BITMAPINFOHEADER bmiHeader;
    public uint c0, c1, c2;
  }

  delegate bool EnumProc(IntPtr h, IntPtr l);

  public const int SW_RESTORE = 9;
  public const uint GA_ROOT = 2;

  public static string Title(IntPtr h) {
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    var sb = new StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  // One line per visible top-level window: hwnd \x01 pid \x01 title
  public static string[] Visible() {
    var list = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Trim().Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      list.Add(h.ToInt64() + "\u0001" + pid + "\u0001" + t);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  // One line per top-level window, visible or not:
  //   hwnd \x01 pid \x01 visible \x01 class \x01 w \x01 h \x01 title
  //
  // Visible() only answers "what is on screen"; this one also answers
  // "what exists", which is what we need to tell a real window apart from
  // a hidden helper or a zero-sized host. Class name matters because a
  // Chromium/Qt host window often has a perfectly ordinary Chinese title.
  public static string[] Dump() {
    var list = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      RECT r;
      GetWindowRect(h, out r);
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      list.Add(h.ToInt64() + "\u0001" + pid + "\u0001" +
        (IsWindowVisible(h) ? 1 : 0) + "\u0001" + cls.ToString() + "\u0001" +
        (r.R - r.L) + "\u0001" + (r.B - r.T) + "\u0001" + Title(h));
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  // Top-level window that owns the given screen point. This -- not the
  // foreground window -- is what actually decides where a click lands.
  public static long WindowAt(int x, int y) {
    POINT p;
    p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) { return 0; }
    IntPtr root = GetAncestor(h, GA_ROOT);
    return (root == IntPtr.Zero ? h : root).ToInt64();
  }

  public static int PidOf(long hwnd) {
    if (hwnd == 0) { return 0; }
    uint pid;
    GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
    return (int)pid;
  }

  public static string ClassName(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }

  // Coarse grayscale fingerprint of a window's client area: cols x rows
  // samples taken on a regular grid. Used to answer "did anything on screen
  // actually change after the click".
  //
  // This must be fast, because it runs inside a polling loop. The obvious
  // implementation -- one GetPixel per sample -- is a trap: 384 GetPixel
  // calls took 3.4 SECONDS on this machine (every call flushes the GDI batch),
  // so the whole polling window was only enough for a single sample and a
  // change that happened later was never seen. StretchBlt + GetDIBits does the
  // same job in a few milliseconds.
  //
  // The client rect (not the whole window) is used on purpose: when a window
  // merely gains or loses focus its border changes colour, which would look
  // like "content changed" even though nothing happened inside.
  public static byte[] Thumb(IntPtr h, int cols, int rows) {
    if (h == IntPtr.Zero || cols <= 1 || rows <= 1) { return null; }
    RECT rc;
    if (!GetClientRect(h, out rc)) { return null; }
    int w = rc.R - rc.L;
    int hh = rc.B - rc.T;
    if (w < 40 || hh < 40) { return null; }
    POINT org;
    org.X = 0; org.Y = 0;
    if (!ClientToScreen(h, ref org)) { return null; }
    return Grab(org.X, org.Y, w, hh, cols, rows);
  }

  // Squash a screen rectangle down to cols x rows of grayscale, in one blit.
  public static byte[] Grab(int sx, int sy, int sw, int sh, int cols, int rows) {
    if (sw < 8 || sh < 8 || cols <= 0 || rows <= 0) { return null; }
    IntPtr src = GetDC(IntPtr.Zero);
    if (src == IntPtr.Zero) { return null; }
    IntPtr mem = CreateCompatibleDC(src);
    IntPtr bmp = CreateCompatibleBitmap(src, cols, rows);
    if (mem == IntPtr.Zero || bmp == IntPtr.Zero) {
      if (mem != IntPtr.Zero) { DeleteDC(mem); }
      if (bmp != IntPtr.Zero) { DeleteObject(bmp); }
      ReleaseDC(IntPtr.Zero, src);
      return null;
    }

    IntPtr old = SelectObject(mem, bmp);
    int stride = ((cols * 3 + 3) / 4) * 4;
    IntPtr bits = Marshal.AllocHGlobal(stride * rows);
    var outp = new byte[cols * rows];
    bool ok = false;
    try {
      SetStretchBltMode(mem, 3);  // COLORONCOLOR: nearest colour, cheapest
      if (StretchBlt(mem, 0, 0, cols, rows, src, sx, sy, sw, sh, 0x00CC0020)) {
        var bi = new BITMAPINFO();
        bi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bi.bmiHeader.biWidth = cols;
        bi.bmiHeader.biHeight = -rows;   // negative: top-down rows
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 24;
        bi.bmiHeader.biCompression = 0;  // BI_RGB
        if (GetDIBits(mem, bmp, 0, (uint)rows, bits, ref bi, 0) != 0) {
          var buf = new byte[stride * rows];
          Marshal.Copy(bits, buf, 0, buf.Length);
          for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
              int i = r * stride + c * 3;
              int bb = buf[i], gg = buf[i + 1], rr = buf[i + 2];
              outp[r * cols + c] = (byte)((rr * 29 + gg * 150 + bb * 77) >> 8);
            }
          }
          ok = true;
        }
      }
    } finally {
      Marshal.FreeHGlobal(bits);
      SelectObject(mem, old);
      DeleteObject(bmp);
      DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, src);
    }
    return ok ? outp : null;
  }

  // Mean absolute difference between two fingerprints, 0..255.
  // -1 means "cannot compare" (one side missing).
  public static int Diff(byte[] a, byte[] b) {
    if (a == null || b == null || a.Length == 0 || a.Length != b.Length) { return -1; }
    long sum = 0;
    for (int i = 0; i < a.Length; i++) {
      int d = a[i] - b[i];
      if (d < 0) { d = -d; }
      sum += d;
    }
    return (int)(sum / a.Length);
  }

  // Fingerprint of a square of screen around a point, clamped to the client
  // area of h. This exists because Thumb(h, 24, 16) -- 384 samples spread over
  // the whole 1204x1029 client area -- dilutes a page transition to almost
  // nothing: measured 7~10 against a threshold of 6, i.e. one unit of margin.
  // The page changes a *region*; averaging over the whole window throws that
  // away. Sampling 400x400 around the click point keeps the signal in the
  // tens, on the exact pixels the decision is about.
  //
  // Clamping to the client rect matters: without it a click near the window
  // edge would sample the desktop behind it, where unrelated animation (a
  // video, a clock) would read as "the page changed".
  public static byte[] ThumbAt(IntPtr h, int px, int py, int half, int cols, int rows) {
    if (h == IntPtr.Zero || half <= 0) { return null; }
    RECT rc;
    if (!GetClientRect(h, out rc)) { return null; }
    POINT org;
    org.X = 0; org.Y = 0;
    if (!ClientToScreen(h, ref org)) { return null; }
    int cl = org.X, ct = org.Y;
    int cr = org.X + (rc.R - rc.L), cb = org.Y + (rc.B - rc.T);
    int x0 = px - half, y0 = py - half, x1 = px + half, y1 = py + half;
    if (x0 < cl) { x0 = cl; }
    if (y0 < ct) { y0 = ct; }
    if (x1 > cr) { x1 = cr; }
    if (y1 > cb) { y1 = cb; }
    if (x1 - x0 < 16 || y1 - y0 < 16) { return null; }
    return Grab(x0, y0, x1 - x0, y1 - y0, cols, rows);
  }

  // Fingerprint of a fractional sub-rectangle of the client area, e.g.
  // (0.30,0.72, 0.10,0.70) = "the result list": past the left rail, below the
  // tab strip. Same reasoning as ThumbAt -- a page transition changes a
  // *region*, and averaging it over the whole window dilutes the signal -- but
  // here the region has to be expressed in fractions, because the "ready"
  // gate runs before anything is known about where the first result card will
  // be. It is deliberately the same region the S1 region detector scans, so
  // the two agree on what "the results" means.
  public static byte[] ThumbRect(IntPtr h, double fx0, double fx1, double fy0, double fy1, int cols, int rows) {
    if (h == IntPtr.Zero || cols <= 1 || rows <= 1) { return null; }
    RECT rc;
    if (!GetClientRect(h, out rc)) { return null; }
    int cw = rc.R - rc.L;
    int ch = rc.B - rc.T;
    if (cw < 40 || ch < 40) { return null; }
    POINT org;
    org.X = 0; org.Y = 0;
    if (!ClientToScreen(h, ref org)) { return null; }
    int cl = org.X, ct = org.Y;
    int cr = cl + cw, cb = ct + ch;
    int x0 = cl + (int)(cw * fx0);
    int y0 = ct + (int)(ch * fy0);
    int x1 = cl + (int)(cw * fx1);
    int y1 = ct + (int)(ch * fy1);
    if (x0 < cl) { x0 = cl; }
    if (y0 < ct) { y0 = ct; }
    if (x1 > cr) { x1 = cr; }
    if (y1 > cb) { y1 = cb; }
    if (x1 - x0 < 16 || y1 - y0 < 16) { return null; }
    return Grab(x0, y0, x1 - x0, y1 - y0, cols, rows);
  }

  // ---- process tree without WMI ----
  // Get-CimInstance Win32_Process costs 770~900ms on this machine (it crosses
  // into the WMI service, which may be busy); a Toolhelp32 snapshot is one
  // kernel call plus a short walk (~1~5ms) and answers the same question:
  // pid -> parent pid. The tree walk itself is unchanged.
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 pe);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 pe);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

  // All descendants of rootPid, rootPid included.
  // Returns an empty array when the snapshot itself failed -- the caller then
  // falls back to WMI, so a blocked/renamed API degrades to "slow but right"
  // instead of "fast but empty".
  public static int[] ParentTree(int rootPid) {
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { return new int[0]; }
    var parent = new Dictionary<int, int>();
    try {
      var pe = new PROCESSENTRY32();
      pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (Process32FirstW(snap, ref pe)) {
        do {
          parent[(int)pe.th32ProcessID] = (int)pe.th32ParentProcessID;
        } while (Process32NextW(snap, ref pe));
      }
    } finally {
      CloseHandle(snap);
    }
    if (parent.Count == 0) { return new int[0]; }

    var set = new HashSet<int>();
    set.Add(rootPid);
    bool grew = true;
    while (grew) {
      grew = false;
      foreach (var kv in parent) {
        if (set.Contains(kv.Value) && !set.Contains(kv.Key)) { set.Add(kv.Key); grew = true; }
      }
    }
    var outp = new int[set.Count];
    set.CopyTo(outp);
    return outp;
  }

  // SetForegroundWindow is refused by the shell unless the caller is (or was
  // recently) the foreground process -- which a child powershell spawned by
  // Electron is not. Attaching to the current foreground thread borrows its
  // input state, which is the standard way around the foreground lock.
  // Returns whether the target really ended up in front.
  public static bool ForceForeground(IntPtr h) {
    if (SetForegroundWindow(h)) { return true; }
    uint fgPid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    try {
      if (fgThread != 0 && fgThread != myThread) {
        attached = AttachThreadInput(myThread, fgThread, true);
      }
      BringWindowToTop(h);
      SetForegroundWindow(h);
      SetFocus(h);
    } catch { }
    if (attached) { AttachThreadInput(myThread, fgThread, false); }
    return GetForegroundWindow() == h;
  }

  public static void ClickLeft(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); // LEFTDOWN
    System.Threading.Thread.Sleep(45);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); // LEFTUP
  }
}
"@

# DPI awareness.
#
# powershell.exe ships as DPI-unaware: on a 125% display GetWindowRect returns
# coordinates divided by 1.25, while GDI's CopyFromScreen works in physical
# pixels. Mixing the two produces a screenshot that is offset and scaled --
# the first version of this file did exactly that and captured half the desktop
# instead of the chat window. Making the process per-monitor-aware makes rect,
# capture and SetCursorPos all speak physical pixels.
#
# Both entry points are tried because the newer one is missing on Win7/8.
try { [void][QrWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {
  try { [void][QrWin]::SetProcessDpiAwareness(2) } catch { }
}

# Milliseconds spent on process start + script parse + compiling the C# block
# + creating the helper functions below.
# NOTE: the assignment sits right before the action dispatch at the bottom of
# this file on purpose -- everything above it is per-process overhead that has
# nothing to do with which action was asked for. Stopping the clock earlier
# (right after Add-Type) leaves roughly 800ms of PowerShell module loading and
# first-cmdlet JIT attributed to the action, which makes a 4-line action like
# "hit" look like it costs a second.
# Temporary: see $SW above.

# ---------------------------------------------------------- WeChat family
#
# WeChat 4.x is not one window and not one process. Measured on this machine:
#
#   explorer(6700)
#     +-- Weixin.exe(8176)                 <- owns the main window
#     |     +-- Weixin.exe x4              <- renderer / helper processes
#     |     +-- WeChatAppEx.exe(28408)     <- built-in browser + mini-program host
#     |           +-- WeChatAppEx.exe x9
#   WeixinUpdate.exe(26444)                <- a DIFFERENT tree, whose window is
#                                             also titled "WeChat"
#
# So neither "the process named Weixin" nor "the window titled WeChat" is a
# usable identifier: the first misses the app host (where the search result
# page actually lives), the second picks up the updater. What really
# identifies "our WeChat" is the process tree rooted at the Weixin.exe that
# owns the main window -- that pulls in WeChatAppEx and leaves the updater out.
#
# Everything downstream (foreground check, typing target, screenshot target,
# click target) is expressed in terms of that pid set.
function Get-WxRoot {
  $list = @(Get-Process Weixin, WeChat -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 })
  if ($list.Count -eq 0) { return $null }
  # Multi-account: prefer a restored window, then the oldest pid.
  $list = @($list | Sort-Object -Property @{ Expression = { if ([QrWin]::IsIconic($_.MainWindowHandle)) { 1 } else { 0 } } }, Id)
  return $list[0]
}

# Every descendant of $rootPid, plus $rootPid itself.
#
# Keeping names out of this is deliberate: a WeChat build that renames its
# browser host would silently start missing windows, which is exactly the
# failure this function exists to fix. What identifies the family is the
# process tree, so the only question is "who descends from the root".
#
# Two ways to get the parent links:
#   - Toolhelp32 (kernel snapshot): 1~5ms, used first
#   - WMI (Get-CimInstance):        770~900ms, kept as the fallback
# The fallback is not decoration: if the snapshot API is blocked or returns
# nothing, the tree is computed the old slow but reliable way instead of
# coming back empty (an empty family would make every foreground check fail).
# A HashSet is returned through "," so PowerShell does not unroll it into an
# int[] on the way out (an int[] has no .Contains(), and the next call site
# would break in a very confusing way).
function Get-WxFamily([int]$rootPid) {
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  if ($rootPid -le 0) { return , $set }
  [void]$set.Add($rootPid)

  try {
    $arr = @([QrWin]::ParentTree($rootPid))
    if ($arr.Count -gt 1) {
      foreach ($p in $arr) { [void]$set.Add([int]$p) }
      return , $set
    }
  } catch { }

  $procs = @()
  try { $procs = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop) } catch { }
  if ($procs.Count -eq 0) { return , $set }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $procs) {
      if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) {
        [void]$set.Add([int]$p.ProcessId)
        $grew = $true
      }
    }
  }
  return , $set
}

function Parse-Pids([string]$s) {
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($x in ($s -split ',')) {
    $n = 0
    if ([int]::TryParse($x.Trim(), [ref]$n) -and $n -gt 0) { [void]$set.Add($n) }
  }
  return , $set
}

# Every top-level window belonging to $fam, visible or not, with geometry.
function Get-WxWindows($fam) {
  $out = @()
  if ($null -eq $fam -or $fam.Count -eq 0) { return $out }
  foreach ($line in [QrWin]::Dump()) {
    $f = $line -split ([char]1)
    if ($f.Length -lt 7) { continue }
    $wpid = [int]$f[1]
    if (-not $fam.Contains($wpid)) { continue }
    $w = [int]$f[4]; $h = [int]$f[5]
    $out += @{
      hwnd = [int64]$f[0]
      pid = $wpid
      visible = [int]$f[2]
      cls = $f[3]
      w = $w; h = $h
      title = $f[6]
      area = ($w * $h)
    }
  }
  return $out
}

# Plain visible-window snapshot in the shape the JS side compares:
# [{hwnd, pid, title}, ...]. Used both before and after a click.
function Get-VisibleList {
  $list = @()
  foreach ($line in [QrWin]::Visible()) {
    $f = $line -split ([char]1)
    if ($f.Length -ge 3) { $list += @{ hwnd = [int64]$f[0]; pid = [int]$f[1]; title = $f[2] } }
  }
  return $list
}

# H2 (third batch): wait until a window of OUR family holds the focus, or until
# the timeout expires. Returns the last observation either way, so the caller
# can report "who actually got it" on failure.
#
# The predicate is the family pid SET, never "is the foreground our own pid":
# this runs inside the helper process, whose pid belongs to nothing we want to
# type into, and the window that has to end up in front may be a WeChatAppEx
# child (the result page), not the main window we asked for.
#
# Why poll at all: ForceForeground returns as soon as the call succeeds, and the
# switch is normally visible within 20~80ms; the flat 260ms sleep that used to
# sit here was the worst case, paid on every single handover.
function Wait-ForegroundInFamily($fam, [int]$timeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $h = [QrWin]::GetForegroundWindow()
  $holder = [QrWin]::PidOf([int64]$h)
  while (-not $fam.Contains($holder)) {
    if ($sw.ElapsedMilliseconds -ge $timeoutMs) { break }
    Start-Sleep -Milliseconds $script:FG_STEP
    $h = [QrWin]::GetForegroundWindow()
    $holder = [QrWin]::PidOf([int64]$h)
  }
  $sw.Stop()
  # hwnd stays an IntPtr (not [int64]): the call site passes it straight to
  # Title/ClassName/PidOf, and keeping the native type avoids a boxing
  # conversion in the one branch that reports a failure.
  return @{ hwnd = $h; pid = [int]$holder }
}

# Which window should we type into / capture / click inside?
#   1. the current foreground window, if it belongs to the family -- after the
#      search runs, the result page may live in a WeChatAppEx window, and that
#      window is the one on screen and the one the user is looking at
#   2. otherwise the Weixin main window
#   3. otherwise the largest visible family window
function Select-WxTarget($fam, [int64]$rootHwnd) {
  $all = @(Get-WxWindows -fam $fam)
  $usable = @($all | Where-Object {
    $_.visible -eq 1 -and $_.w -gt 60 -and $_.h -gt 60 -and $_.title.Trim().Length -gt 0
  })
  if ($usable.Count -eq 0) { return @{ target = $null; how = "none"; all = $all } }

  $fg = [int64][QrWin]::GetForegroundWindow()
  foreach ($c in $usable) {
    if ($c.hwnd -eq $fg) { return @{ target = $c; how = "foreground"; all = $all } }
  }
  foreach ($c in $usable) {
    if ($c.hwnd -eq $rootHwnd) { return @{ target = $c; how = "main"; all = $all } }
  }
  $big = $usable | Sort-Object -Property area -Descending | Select-Object -First 1
  return @{ target = $big; how = "largest"; all = $all }
}

function Get-WechatWindow {
  return Get-WxRoot
}

function Emit($obj) {
  # Temporary (timing instrumentation): report both ends of the per-call
  # overhead on every reply, so the JS side can split a call into three parts:
  #   bootMs  = one-shot: process start + parse + Compile C# + warm-up
  #             resident: request read + option dispatch (a few ms)
  #   emitAt  = stopwatch value at the moment the action finished (minus boot = work)
  #   total - emitAt = one-shot: JSON + module unload + process exit
  #                    resident: pipe write + Node-side parse
  # Delete this block when removing the timing instrumentation.
  if ($obj -is [hashtable]) {
    if ($null -ne $script:REQ_ID) { $obj["id"] = [int]$script:REQ_ID }
    if ($null -ne $script:BOOT) { $obj["bootMs"] = [int]$script:BOOT }
    if ($null -ne $script:SW) { $obj["emitAt"] = [int]$script:SW.ElapsedMilliseconds }
  }
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  # Resident mode keeps its own writer: AutoFlush is what makes the reply
  # visible to Node immediately instead of whenever the pipe buffer fills.
  if ($null -ne $script:PIPE_OUT) { $script:PIPE_OUT.WriteLine($json) }
  else { [Console]::Out.WriteLine($json) }
}

# Any terminating error used to leave the caller with an empty stdout and a
# useless "no-json". Report the message (base64: stdout stays ASCII) and the
# script line instead, so a failing action is diagnosable from the Node side.
#
# This replaced a script-level `trap { ...; return }`. A trap cannot be used in
# resident mode: after handling one it resumes at the statement following the
# one that threw, which in a loop means "carry on in the middle of an aborted
# request". Explicit try/catch at both dispatch sites is unambiguous.
function Emit-Exception($err) {
  $msg = ""
  $line = 0
  try { $msg = [string]$err.Exception.Message } catch { }
  try { $line = [int]$err.InvocationInfo.ScriptLineNumber } catch { }
  Emit @{
    ok = $false
    error = "exception"
    msg = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($msg))
    line = $line
  }
}

# ------------------------------------------------------------ request options
#
# Defaults for every option a request can carry. They are applied on EVERY
# request, before the action runs. That is the difference between "a missing
# field means the default" and "a missing field means whatever the previous
# request happened to pass" -- with a resident worker the second is a very real
# way to click at the last search's coordinates.
$script:OPT_DEF = @{
  out = ""; wait = 0; x = 0; y = 0; keys = ""
  target = ""; targetpid = 0; pids = ""; file = ""
  hwnd = 0; win = 0; poll = 4000; full = $false
  ready = $true
}

# ---- polling / readiness tuning (third batch; all four are rollback points) ----
# Every value here replaced a flat sleep. They are script scope on purpose: one
# place to look, and no risk of a local variable shadowing a name that some
# other branch also reads (the $sw/$SW trap).
$script:FG_STEP = 30        # keys: how often to re-check "who holds the focus"
$script:POLL_STEP = 100     # click: how often to look for evidence (was 250)
$script:READY_STEP = 40     # keys: how often to re-fingerprint the result area
$script:READY_DIFF = 10     # keys: "no longer the pre-Enter screen" (0..255)
$script:READY_STABLE = 6    # keys: "and it stopped moving", per-frame tolerance
$script:UIA_TRIES = 8       # uiafind: passes over the family windows (was 3)
$script:UIA_STEP = 120      # uiafind: pause between passes (was 3 x 700ms)

# Read one field out of a request and coerce it to the type the action expects.
# The type is inferred from the default, which is why $script:OPT_DEF exists:
# one place defines both "what the default is" and "what type it must become".
# Accepts a hashtable (one-shot mode builds one) or the PSCustomObject that
# ConvertFrom-Json produces.
function Get-Opt($o, [string]$name, $default) {
  if ($null -eq $o) { return $default }
  $v = $null
  if ($o -is [System.Collections.IDictionary]) {
    if (-not $o.Contains($name)) { return $default }
    $v = $o[$name]
  } else {
    $prop = $o.PSObject.Properties[$name]
    if ($null -eq $prop) { return $default }
    $v = $prop.Value
  }
  if ($null -eq $v) { return $default }
  if ($default -is [int]) {
    $n = 0
    if ([int]::TryParse([string]$v, [ref]$n)) { return $n }
    return $default
  }
  if ($default -is [bool]) {
    if ($v -is [bool]) { return $v }
    $s = ([string]$v).Trim().ToLower()
    return ($s -eq "true" -or $s -eq "1")
  }
  return [string]$v
}

# Push one request's options onto the script-scope variables the action bodies
# read. They are script scope (not locals) so the bodies below stay exactly as
# they were when everything ran at script scope -- same names, same defaults,
# one code path for both run modes.
function Use-Request($o) {
  # One-shot keeps the process-wide clock: bootMs is *supposed* to include the
  # startup cost in that mode. Resident restarts it, so bootMs becomes the
  # request dispatch and "work" stays comparable with the one-shot numbers.
  if ($script:SERVE) { $script:SW = [System.Diagnostics.Stopwatch]::StartNew() }
  $script:Out = Get-Opt $o "out" $script:OPT_DEF.out
  $script:WaitMs = Get-Opt $o "wait" $script:OPT_DEF.wait
  $script:X = Get-Opt $o "x" $script:OPT_DEF.x
  $script:Y = Get-Opt $o "y" $script:OPT_DEF.y
  $script:Keys = Get-Opt $o "keys" $script:OPT_DEF.keys
  $script:Target = Get-Opt $o "target" $script:OPT_DEF.target
  $script:TargetPid = Get-Opt $o "targetpid" $script:OPT_DEF.targetpid
  $script:Pids = Get-Opt $o "pids" $script:OPT_DEF.pids
  $script:File = Get-Opt $o "file" $script:OPT_DEF.file
  $script:Hwnd = Get-Opt $o "hwnd" $script:OPT_DEF.hwnd
  $script:Win = Get-Opt $o "win" $script:OPT_DEF.win
  $script:PollMs = Get-Opt $o "poll" $script:OPT_DEF.poll
  $script:Full = Get-Opt $o "full" $script:OPT_DEF.full
  $script:Ready = Get-Opt $o "ready" $script:OPT_DEF.ready
}

# Everything above this line ran before we even know which action was asked
# for, so it is pure per-process overhead -- in resident mode, pure startup
# cost that the user never waits for. Everything below (and only that) is
# reported as "work".
#
# Temporary (timing instrumentation): warm up the things every process pays for
# exactly once, so their cost lands in "boot" instead of being blamed on
# whichever action happens to run first:
#   - JIT of the freshly compiled QrWin helpers (measured: ~850ms!)
#   - first use of ConvertTo-Json / loading the Utility module
# Without this warm-up a 4-line action like "hit" reports ~850ms of "work",
# which is pure nonsense and would send anyone optimising in the wrong place.
#
# D (second batch): Thumb / Diff / Visible are warmed here for a different
# reason -- not for measurement, but because the first call to each pays a JIT
# plus the first GDI round trip (~150~250ms), and in the old design that bill
# landed inside "click" while the user was waiting for their page. Paying it at
# worker start moves it into the QR-scanning seconds. Warming them only pays
# off together with the resident worker: on a one-shot process it would merely
# move the cost from "work" to "boot" of the same call.
#
# Delete this try-block together with $SW/$BOOT when the instrumentation goes.
try {
  [void][QrWin]::GetForegroundWindow()
  [void][QrWin]::Title([IntPtr]::Zero)
  [void][QrWin]::ClassName([IntPtr]::Zero)
  $null = @{ warm = 1 } | ConvertTo-Json -Compress
  # Any handle will do (zero = "no window"): the primitives return null early,
  # but the JIT and the GDI entry points are still exercised, which is the
  # whole point.
  $warmH = [QrWin]::GetForegroundWindow()
  $warmA = $null
  try { $warmA = [QrWin]::Thumb($warmH, 8, 8) } catch { }
  if ($null -ne $warmA) { $null = [QrWin]::Diff($warmA, $warmA) }
  $null = [QrWin]::Visible()

  # P0 (third batch): the first wxprobe and the first uiafind of a freshly
  # started worker each paid a one-off bill inside the handover the user was
  # waiting for -- measured 283 -> 30~61ms for probe and 246 -> 62~84ms for
  # uia, ~450ms together, and only on the first handover after a restart.
  #
  # Warming them here moves that bill into worker start, which happens while
  # the user is still scanning the QR code and nobody is waiting.
  #
  # DO NOT warm by calling the "wxprobe" action: it runs ShowWindow(SW_RESTORE)
  # and would pop a minimised WeChat window up on screen. These are the same
  # primitives it uses, minus the restore.
  try {
    $warmRoot = Get-WxRoot
    if ($warmRoot) { $null = Get-WxFamily ([int]$warmRoot.Id) }
    $null = [QrWin]::Dump()
    $null = Get-VisibleList
    # Loading the UIA assemblies happens once per process; ~100ms of it used to
    # land inside the first uiafind, together with Chromium building its
    # accessibility tree for the very first time.
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  } catch { }
} catch { }

# In resident mode everything up to here is startup, paid once, before the
# first request is read. Node reports it separately as "worker boot".
$script:WORKER_START = $SW.ElapsedMilliseconds

# ------------------------------------------------------------- action bodies
#
# One function so both run modes share one implementation. The bodies below are
# byte-for-byte the ones that used to sit at script scope; the only change is
# that `exit 0` (which meant "reply and stop the process") became `return`
# (which means "reply and stop this request"), because in resident mode the
# process has to survive the reply.
function Invoke-Action([string]$a, $o) {
  Use-Request $o
  # Temporary (timing instrumentation): end of the per-request overhead. In
  # resident mode that is the option dispatch only (a few ms); in one-shot mode
  # it still includes the whole startup, which is what boots is for.
  $script:BOOT = $SW.ElapsedMilliseconds

switch ($a) {

  # Restore the WeChat window and report its rect. A minimized window reports
  # (-25600, -25600) from GetWindowRect -- the Windows convention for iconified
  # windows -- so it has to be restored before any key or click can land.
  "probe" {
    $p = Get-WechatWindow
    if (-not $p) { Emit @{ ok = $false; error = "no-wechat-window" }; return }
    $h = $p.MainWindowHandle
    $min = [QrWin]::IsIconic($h)
    if ($min) {
      [void][QrWin]::ShowWindow($h, [QrWin]::SW_RESTORE)
      Start-Sleep -Milliseconds 320
    }
    [void][QrWin]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 180
    $r = New-Object QrWin+RECT
    [void][QrWin]::GetWindowRect($h, [ref]$r)
    $c = New-Object QrWin+POINT
    [void][QrWin]::GetCursorPos([ref]$c)
    Emit @{
      ok = $true
      hwnd = [int64]$h
      pid = $p.Id
      x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T)
      cursor = @($c.X, $c.Y)
      minimized = $min
      title = [QrWin]::Title($h)
      fg = [int64][QrWin]::GetForegroundWindow()
    }
  }

  # ---------------------------------------------------------------- wxprobe
  #
  # Read-only answer to "which process tree is this WeChat, and which window
  # should the next step act on". The only side effect is restoring a
  # minimized main window -- a minimized window reports (-25600,-25600) and
  # captures as a 160x28 title bar, which would poison every later step.
  #
  # The JS side calls this exactly once per handover, before typing: it is the
  # one place that establishes "our WeChat" = this pid set. The question
  # "which window is on screen now" is asked later, inside "keys", because by
  # then the result page may have moved into a WeChatAppEx window of its own.
  "wxprobe" {
    $root = Get-WxRoot
    if (-not $root) { Emit @{ ok = $false; error = "no-wechat-window" }; return }
    $rootH = $root.MainWindowHandle
    $restored = $false
    if ([QrWin]::IsIconic($rootH)) {
      [void][QrWin]::ShowWindow($rootH, [QrWin]::SW_RESTORE)
      Start-Sleep -Milliseconds 320
      $restored = $true
    }

    # The family is always computed here -- this action is the ONE place that
    # establishes it, and everything downstream (foreground check, typing
    # target, click validation) is expressed in terms of it.
    #
    # There used to be a "-Pids" fast path so a second wxprobe after the search
    # could skip the tree walk. It is gone together with that second call:
    # asking "which window is on screen now" is now answered inside "keys"
    # (Select-WxTarget, one EnumWindows) instead of by a whole new process.
    # Two ways to establish the same set, one of them only cheaper, was a
    # standing invitation to pick the wrong one.
    $fam = Get-WxFamily ([int]$root.Id)
    $sel = Select-WxTarget -fam $fam -rootHwnd ([int64]$rootH)
    $tgt = $sel.target

    $rect = $null
    if ($tgt) {
      $r = New-Object QrWin+RECT
      [void][QrWin]::GetWindowRect([IntPtr][int64]$tgt.hwnd, [ref]$r)
      $rect = @{ x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
    }

    $fg = [int64][QrWin]::GetForegroundWindow()
    $fgPid = [QrWin]::PidOf($fg)

    # Full visible-window snapshot, same shape as the "windows" action, so the
    # caller can use it as the "before" side of the click verification: the
    # result page may open a window of its own, and that must not later be
    # mistaken for "the click opened a page".
    $snapshot = @()
    foreach ($line in [QrWin]::Visible()) {
      $f = $line -split ([char]1)
      if ($f.Length -ge 3) {
        $snapshot += @{ hwnd = [int64]$f[0]; pid = [int]$f[1]; title = $f[2]; family = $fam.Contains([int]$f[1]) }
      }
    }

    # Resolve the names into a variable first, and only then put it in the
    # reply. Written inline as $(if ... { @(...) } else { @() }) an empty
    # result serialises as {} -- an object, not an array -- which quietly
    # breaks any caller that does .map() on it. An explicit array variable
    # keeps the shape stable: always [], sometimes with items.
    $members = @()
    if ($Full) {
      # Process NAMES are diagnostic only (they exist so a failing run can be
      # read without a debugger, and so the test harness can assert that the
      # family contains WeChatAppEx and excludes WeixinUpdate). Resolving them
      # costs one Get-Process per pid -- measured 189ms for 18 pids, and
      # batching does not help (182ms) because the price is per process, not
      # per call. So it is opt-in via -Full: in the hot path it was ~190ms of
      # pure logging on every handover.
      $members = @($fam | Sort-Object | ForEach-Object {
        @{ pid = [int]$_; name = ([string](Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName) }
      })
    }

    Emit @{
      ok = $true
      root = @{ pid = [int]$root.Id; hwnd = [int64]$rootH; title = [QrWin]::Title($rootH); restored = $restored }
      pids = @($fam | Sort-Object)
      members = $members
      pidsFrom = $(if ($fam.Count -gt 1) { "tree" } else { "self" })
      fg = @{ hwnd = $fg; pid = $fgPid; inFamily = $fam.Contains($fgPid); title = [QrWin]::Title([IntPtr]$fg) }
      target = $tgt
      targetHow = $sel.how
      rect = $rect
      familyWindows = @($sel.all | Where-Object { $_.visible -eq 1 })
      windows = $snapshot
    }
  }

  # Send a key sequence to the foreground window, then grab the WeChat window
  # as a PNG. The sequence uses SendKeys syntax and may be interleaved with
  # plain-integer pauses, e.g. "^f,400,^v,300,{ENTER}"
  #
  # Restore + focus + foreground check all happen here rather than in a separate
  # "probe" call: the whole point is that keys must land in WeChat and nowhere
  # else, so the check has to be in the same process, immediately before typing.
  "keys" {
    # Temporary (timing instrumentation): keys is the busiest step in the
    # chain -- foreground grab, typing, waiting for results, screenshot,
    # window enumeration. Each is timed and reported below as t.fg / t.type /
    # t.wait / t.shot / t.list, which separates "waiting" from "working".
    $k0 = $SW.ElapsedMilliseconds
    # Target window: -Win when the caller already picked one, otherwise the
    # root main window. The foreground check uses the *pid set*, not a single
    # hwnd -- the window holding the focus is very often a WeChatAppEx window
    # (the search result page), and that must not read as "WeChat is behind".
    $fam = Parse-Pids $Pids
    $root = Get-WxRoot
    $rootH = [IntPtr]::Zero
    $rootPid = 0
    if ($root) { $rootPid = [int]$root.Id; $rootH = $root.MainWindowHandle }
    if ($fam.Count -eq 0) {
      if ($rootPid -eq 0) { Emit @{ ok = $false; error = "no-wechat-window" }; return }
      $fam = Get-WxFamily $rootPid
    }

    $h = $rootH
    if ($Win -gt 0) { $h = [IntPtr][int64]$Win }
    if ($h -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = "no-wechat-window" }; return }

    if ([QrWin]::IsIconic($h)) {
      [void][QrWin]::ShowWindow($h, [QrWin]::SW_RESTORE)
      Start-Sleep -Milliseconds 340
    }

    # ForceForeground first tries plain SetForegroundWindow and, when the shell
    # refuses it (child process, no recent input), borrows the current
    # foreground thread's input state.
    # H2: then poll for the switch instead of sleeping a flat 260ms -- the
    # sleep was the worst case and cost 271~311ms on every handover.
    [void][QrWin]::ForceForeground($h)
    $fgw = Wait-ForegroundInFamily -fam $fam -timeoutMs 260
    $fg = $fgw.hwnd
    $fgPid = $fgw.pid

    # One retry against the root window: a freshly restored child window
    # sometimes cannot take the foreground before its owner is active.
    if (-not $fam.Contains($fgPid) -and $rootH -ne [IntPtr]::Zero -and $rootH -ne $h) {
      [void][QrWin]::ForceForeground($rootH)
      $fgw = Wait-ForegroundInFamily -fam $fam -timeoutMs 240
      $fg = $fgw.hwnd
      $fgPid = $fgw.pid
    }

    # Temporary (timing): end of the foreground grab -- includes restoring a
    # minimised window, ForceForeground, the fixed sleeps and the 240ms retry.
    $kFg = $SW.ElapsedMilliseconds

    if (-not $fam.Contains($fgPid)) {
      # Report both sides so a failure is diagnosable without a debugger:
      # want = our process family, got = whoever actually holds the focus.
      Emit @{
        ok = $false
        error = "not-foreground"
        want = @{ hwnd = [int64]$h; pid = $rootPid; family = @($fam | Sort-Object) }
        got = @{ hwnd = [int64]$fg; pid = $fgPid; title = [QrWin]::Title($fg); cls = [QrWin]::ClassName($fg) }
      }
      return
    }

    Add-Type -AssemblyName System.Windows.Forms
    $parts = $Keys -split ","
    # F1 (third batch): the "wait for the results" step stops being a blind
    # sleep. Baseline = fingerprint of the result area taken immediately before
    # Enter, then re-sampled every READY_STEP ms until the screen has changed
    # AND settled; $WaitMs becomes the upper bound instead of the duration.
    #
    # Taken before Enter and not before the whole sequence on purpose: earlier
    # the window still shows a chat or the empty search box, so the search box
    # opening would already look like "results are ready".
    $readyBase = $null
    $wantReady = ($Ready -and $WaitMs -gt 0)
    for ($i = 0; $i -lt $parts.Length; $i++) {
      $seg = $parts[$i].Trim()
      if ($seg -eq "") { continue }
      if ($seg -match '^\d+$') { Start-Sleep -Milliseconds ([int]$seg); continue }
      if ($wantReady -and $null -eq $readyBase -and $seg -match '\{ENTER\}|~') {
        try { $readyBase = [QrWin]::ThumbRect($h, 0.30, 0.72, 0.10, 0.70, 32, 32) } catch { }
      }
      [System.Windows.Forms.SendKeys]::SendWait($seg)
      Start-Sleep -Milliseconds 90
    }
    # Temporary (timing): typing finished -- includes the fixed 560ms after
    # Ctrl+F, 420ms after paste, and 90ms after every key.
    $kType = $SW.ElapsedMilliseconds

    # readyHow: fingerprint (the page was seen appearing) / timeout (the bound
    # was reached without a convincing change) / sleep (polling off or no
    # baseline) / none (WaitMs = 0).
    $readyHow = "none"
    $readyMs = 0
    $readyPeak = -1
    if ($WaitMs -gt 0) {
      if ($wantReady -and $null -ne $readyBase) {
        $readyHow = "timeout"
        $rdySw = [System.Diagnostics.Stopwatch]::StartNew()
        $prevFrame = $null
        while ($rdySw.ElapsedMilliseconds -lt $WaitMs) {
          Start-Sleep -Milliseconds $script:READY_STEP
          $cur = $null
          try { $cur = [QrWin]::ThumbRect($h, 0.30, 0.72, 0.10, 0.70, 32, 32) } catch { }
          if ($null -eq $cur) { continue }
          $d = [QrWin]::Diff($readyBase, $cur)
          if ($d -gt $readyPeak) { $readyPeak = $d }
          # Two conditions, and both matter:
          #   d >= READY_DIFF              -- the region is no longer what it was
          #                                   before Enter, i.e. something loaded
          #   Diff(prev,cur) <= READY_STABLE -- and it has stopped moving, i.e. the
          #                                   page finished painting. Releasing on
          #                                   a half-drawn result list would hand
          #                                   UIA the old coordinates and click
          #                                   into empty space.
          if ($d -ge $script:READY_DIFF -and $null -ne $prevFrame -and
              [QrWin]::Diff($prevFrame, $cur) -le $script:READY_STABLE) {
            $readyHow = "fingerprint"
            break
          }
          $prevFrame = $cur
        }
        $readyMs = [int]$rdySw.ElapsedMilliseconds
        $rdySw.Stop()
      } else {
        # Rollback path (QRSCAN_READY=0) and the "no baseline" case: exactly the
        # old behaviour, so a failure here can never be worse than before.
        $readyHow = "sleep"
        Start-Sleep -Milliseconds $WaitMs
        $readyMs = $WaitMs
      }
    }
    # Temporary (timing): waiting for the result page is over. With F1 this is
    # no longer pure sleep -- it is "as long as the page took, capped at $WaitMs".
    $kWait = $SW.ElapsedMilliseconds

    # ---- which window is on screen NOW ----
    # Only answerable after Enter: from this moment on the result page may live
    # in a WeChatAppEx window of its own, and that window is what has to be
    # captured and clicked -- its rect is also the origin for every coordinate
    # measured inside a screenshot.
    # This is deliberately here and not in a second wxprobe process. Both
    # questions ("which family", "which window") were being answered by two
    # separate one-shot processes over the same data, and the second one cost
    # ~1.5s (fresh boot + tail) to re-derive a tree that had not changed:
    # measured 6/6 handovers answered "main". Select-WxTarget over $fam is one
    # EnumWindows, i.e. the same function the probe called, minus the process.
    $sel = Select-WxTarget -fam $fam -rootHwnd ([int64]$rootH)
    # NOT $target: that is the -Target parameter of this script (the base64
    # needle). Names are case-insensitive, so assigning it here would silently
    # clobber the parameter -- the same trap as $sw/$SW in "click".
    $tgt = $sel.target
    $targetRect = $null
    if ($tgt) {
      $tr = New-Object QrWin+RECT
      [void][QrWin]::GetWindowRect([IntPtr][int64]$tgt.hwnd, [ref]$tr)
      $targetRect = @{ x = $tr.L; y = $tr.T; w = ($tr.R - $tr.L); h = ($tr.B - $tr.T) }
    }
    # Temporary (timing): target selection + its rect.
    $kTgt = $SW.ElapsedMilliseconds

    $r = New-Object QrWin+RECT
    [void][QrWin]::GetWindowRect($h, [ref]$r)
    $rect = @{ x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
    if ($Out -ne "" -and $rect.w -gt 0) {
      Add-Type -AssemblyName System.Drawing
      $bmp = New-Object System.Drawing.Bitmap $rect.w, $rect.h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($rect.x, $rect.y, 0, 0, (New-Object System.Drawing.Size $rect.w, $rect.h))
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
    }
    # Temporary (timing): screenshot done -- includes loading System.Drawing
    # for the first time and encoding the PNG.
    $kShot = $SW.ElapsedMilliseconds

    $list = Get-VisibleList
    # Temporary (timing): visible top-level window enumeration done.
    $kList = $SW.ElapsedMilliseconds

    Emit @{
      ok = $true; rect = $rect; shot = $Out
      hwnd = [int64]$h; pid = [QrWin]::PidOf([int64]$h)
      family = @($fam | Sort-Object)
      windows = $list
      # The window the next steps must act on, decided after the result page
      # appeared. target = $null means "nothing usable" -- the caller then
      # falls back to the window it typed into.
      target = $tgt
      targetHow = $sel.how
      targetRect = $targetRect
      # F1: how the "did the results appear" question was answered, and how long
      # it took. readyHow=fingerprint means the page was actually seen;
      # timeout means the bound was reached with no convincing change (in which
      # case readyPeak says how close it got -- that is the number to tune
      # READY_DIFF with); sleep means polling was off (QRSCAN_READY=0).
      readyMs = $readyMs
      readyHow = $readyHow
      readyPeak = $readyPeak
      # Whether polling was even allowed for this call. Without it, readyHow=sleep
      # is ambiguous: "the switch is off" and "the key string had no Enter, so
      # there was nothing to compare against" look identical in the log.
      readyOn = [bool]$Ready
      # Temporary (timing): per-segment cost in ms. Delete together with the
      # $k* captures above when the instrumentation is removed.
      t = @{
        fg     = [int]($kFg - $k0)
        type   = [int]($kType - $kFg)
        wait   = [int]($kWait - $kType)
        target = [int]($kTgt - $kWait)
        shot   = [int]($kShot - $kTgt)
        list   = [int]($kList - $kShot)
      }
    }
  }

  "click" {
    # The point came from a screenshot taken a moment ago. What decides where a
    # click lands is not the foreground window but the window under that very
    # pixel. WindowFromPoint answers exactly that, and it also covers the case
    # where something else has since moved on top of WeChat -- then the pixel
    # belongs to the newcomer and we refuse instead of clicking blindly.
    $fam = Parse-Pids $Pids
    if ($fam.Count -eq 0) {
      $root = Get-WxRoot
      if (-not $root) { Emit @{ ok = $false; error = "no-wechat-window" }; return }
      $fam = Get-WxFamily ([int]$root.Id)
    }

    $at = [int64][QrWin]::WindowAt($X, $Y)
    $atPid = [QrWin]::PidOf($at)
    if (-not $fam.Contains($atPid)) {
      Emit @{
        ok = $false; error = "not-foreground"; why = "point-outside-family"
        point = @($X, $Y)
        want = @{ family = @($fam | Sort-Object) }
        got = @{ hwnd = $at; pid = $atPid; title = [QrWin]::Title([IntPtr]$at); cls = [QrWin]::ClassName([IntPtr]$at) }
      }
      return
    }

    # ---- before the click ----
    # Three independent kinds of evidence are watched afterwards, because
    # "a new top-level window appeared" is only ONE of the ways a page can
    # open:
    #   - the page may load *inside* the existing WeChat window (no new hwnd)
    #   - a new window may still have an empty title at the moment we look
    #   - on a slow page the new window may appear a second later
    # A fixed 900 ms sleep followed by a single enumeration got all three
    # wrong: it reported "nothing opened" for pages that had opened fine.
    $before = Get-VisibleList
    $beforeSet = @{}
    foreach ($w in $before) { $beforeSet[[int64]$w.hwnd] = 1 }
    $atH = [IntPtr]$at
    $titleBefore = [QrWin]::Title($atH)

    # Fingerprint of what "the page" means here. Two scopes, same gate:
    #   local  -- 400x400 around the click point, 32x32 samples. The page
    #             transition happens exactly there, so the signal is in the
    #             tens and the gate below has real margin.
    #   window -- whole client area, 24x16. Only used when the local square
    #             cannot be taken (point outside the client area, tiny window).
    #             This is the old behaviour whose margin had shrunk to 1 unit
    #             (measured diff 7~10 vs threshold 6), i.e. a false "nothing
    #             changed" -- and therefore a 4s poll plus a bogus error --
    #             was one routine page away.
    $sampleWho = "local400/32"
    $base = $null
    try { $base = [QrWin]::ThumbAt($atH, $X, $Y, 200, 32, 32) } catch { }
    if ($null -eq $base) {
      $sampleWho = "window24x16"
      try { $base = [QrWin]::Thumb($atH, 24, 16) } catch { }
    }

    [QrWin]::ClickLeft($X, $Y)

    # ---- watch for evidence ----
    # Order matters: a brand-new window is the strongest signal, a title
    # change is next, and "the client area changed" is the catch-all that
    # covers a page opening inside the current window.
    # NOTE: must NOT be called $sw -- PowerShell variable names are
    # case-insensitive, so $sw and $SW are the SAME variable and this line
    # would silently replace the script-level stopwatch. Emit() then reports
    # the poll duration as "emitAt", which is smaller than $BOOT, so the
    # JS side rejects it as out of range and falls back to "tail = 0" --
    # exactly the 6/6-zero bug that made click look like 74% pure compute.
    $pollSw = [System.Diagnostics.Stopwatch]::StartNew()
    $verdict = "none"
    $waited = 0
    $pixelDiff = -1
    # Every sample, so a slow or non-monotonic change is visible in the report
    # instead of showing up as a single "waited 3.4s" mystery.
    $trail = @()
    while ($pollSw.ElapsedMilliseconds -lt $PollMs) {
      # H3 (third batch): 250 -> 100ms. The old step was not "how long the page
      # needs", it was "how seldom we look": `waited` sat at 263~273 on every
      # run because the first frame was only taken after a 250ms sleep.
      Start-Sleep -Milliseconds $script:POLL_STEP
      $now = Get-VisibleList

      foreach ($w in $now) {
        if (-not $beforeSet.ContainsKey([int64]$w.hwnd) -and $w.title -and $w.title.Trim().Length -gt 0) {
          $verdict = "window"
          break
        }
      }
      if ($verdict -ne "none") { break }

      $t = [QrWin]::Title($atH)
      if ($titleBefore -ne "" -and $t -ne "" -and $t -ne $titleBefore) {
        $verdict = "title"
        break
      }

      if ($base) {
        $cur = $null
        try {
          if ($sampleWho -eq "local400/32") { $cur = [QrWin]::ThumbAt($atH, $X, $Y, 200, 32, 32) }
          else { $cur = [QrWin]::Thumb($atH, 24, 16) }
        } catch { }
        if ($cur) {
          $pixelDiff = [QrWin]::Diff($base, $cur)
          if ($trail.Count -lt 24) { $trail += $pixelDiff }
          # 6/255 mean absolute difference. The number was never the problem --
          # the scope was: over the whole window a page load only moved this by
          # 7~10. Over the 400x400 around the click point the same event moves
          # it by tens, so 6 now sits well below the signal instead of one unit
          # below it. Left unchanged on purpose: raising it blindly would hide
          # a real signal on a page that only repaints part of the area.
          if ($pixelDiff -ge 6) { $verdict = "pixels"; break }
        }
      }
    }
    $waited = [int]$pollSw.ElapsedMilliseconds
    $pollSw.Stop()

    $c = New-Object QrWin+POINT
    [void][QrWin]::GetCursorPos([ref]$c)
    $list = Get-VisibleList
    Emit @{
      ok = $true; at = @($c.X, $c.Y)
      before = $before; windows = $list
      verdict = $verdict; waited = $waited; pixelDiff = $pixelDiff
      sample = $sampleWho
      trail = $trail
    }
  }

  "windows" {
    $list = Get-VisibleList
    Emit @{ ok = $true; fg = [int64][QrWin]::GetForegroundWindow(); list = $list }
  }

  # Who owns a screen point. Read-only: the click action uses the same
  # primitive (WindowFromPoint + GetAncestor) internally, this action exposes
  # it so a test -- or a user -- can ask "what would a click here hit?"
  # without clicking anything.
  "hit" {
    # Temporary (timing): hit is the cheapest possible action (4 Win32 calls),
    # so it doubles as a probe for per-process overhead. Splitting it shows
    # whether the remainder sits *before* the body (action dispatch) or
    # *after* it (Emit, JSON, process teardown) -- neither of which any
    # optimisation of the search flow could ever remove.
    $hEnter = $SW.ElapsedMilliseconds
    $at = [int64][QrWin]::WindowAt($X, $Y)
    $hBody = $SW.ElapsedMilliseconds
    Emit @{
      ok = $true
      hwnd = $at
      pid = [QrWin]::PidOf($at)
      title = [QrWin]::Title([IntPtr]$at)
      cls = [QrWin]::ClassName([IntPtr]$at)
      t = @{ enter = [int]($hEnter - $BOOT); body = [int]($hBody - $hEnter) }
    }
  }

  # Screenshot one window, touching neither keyboard nor mouse. --wxtest uses
  # this, so it is safe to run at any time. With -Hwnd it captures that
  # window (e.g. the embedded browser window the search results live in);
  # without it, the WeChat main window.
  "shot" {
    $h = [IntPtr]::Zero
    $wxPid = 0
    if ($Hwnd -gt 0) {
      $h = [IntPtr][int64]$Hwnd
    } else {
      $p = Get-WechatWindow
      if (-not $p) { Emit @{ ok = $false; error = "no-wechat-window" }; return }
      $h = $p.MainWindowHandle
      $wxPid = $p.Id
    }
    if ([QrWin]::IsIconic($h)) {
      [void][QrWin]::ShowWindow($h, [QrWin]::SW_RESTORE)
      Start-Sleep -Milliseconds 320
    }
    $r = New-Object QrWin+RECT
    [void][QrWin]::GetWindowRect($h, [ref]$r)
    Add-Type -AssemblyName System.Drawing
    $w = $r.R - $r.L; $h2 = $r.B - $r.T
    $bmp = New-Object System.Drawing.Bitmap $w, $h2
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h2))
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Emit @{ ok = $true; hwnd = [int64]$h; pid = $wxPid; rect = @{ x = $r.L; y = $r.T; w = $w; h = $h2 }; shot = $Out }
  }

  # ---------------------------------------------------------------- uiafind
  #
  # Strategy S2: walk the UI Automation tree of every top-level window that
  # belongs to $TargetPid and return clickable points of the elements whose
  # name contains the decoded $Target text (e.g. "fang wen wang ye").
  #
  # Why this can work even though WeChat 4.x chat UI is Qt-drawn: the SouYiSou
  # result page is rendered by the embedded webview, and Chromium-style engines
  # build a DOM accessibility tree on demand, as soon as a UIA client asks.
  # That is why we poll: the first query itself is what makes the tree appear.
  #
  # Cadence (changed together with the keys "ready" gate, measured 2026-10-24):
  # the ready gate releases as soon as the PIXELS settle (~600-800ms after
  # Enter), but the accessibility tree lags the pixels by roughly another
  # 700ms. With the old "3 passes x 700ms sleep" every single run therefore
  # missed on pass 1 and paid one full 700ms sleep (uia work 62~84 -> 820~833,
  # and a not-yet-rendered page burned all 3 passes -> no-point). Short passes
  # at UIA_STEP match how fast a page actually paints: a miss now costs ~120ms
  # instead of 700ms, and the same total budget covers 8 passes instead of 3.
  #
  # Read-only: no keys, no clicks, no focus changes.
  # All names are returned base64-encoded to keep stdout ASCII-safe.
  "uiafind" {
    $needle = ""
    try { $needle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Target)) } catch { }
    # Accept a whole pid set: the result page may be rendered by a different
    # process (WeChatAppEx) than the one owning the main window, so walking
    # only the main pid is exactly the bug this change fixes.
    $fam = Parse-Pids $Pids
    if ($fam.Count -eq 0 -and $TargetPid -gt 0) { [void]$fam.Add($TargetPid) }
    if ($needle -eq "" -or $fam.Count -eq 0) { Emit @{ ok = $false; error = "bad-args" }; return }

    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $found = @()
    $sample = @()
    $scanned = 0
    $wins = 0
    $attempt = 0
    while ($attempt -lt $script:UIA_TRIES -and $found.Count -eq 0) {
      $attempt++
      foreach ($line in [QrWin]::Visible()) {
        if ($found.Count -ge 5) { break }
        $f = $line -split ([char]1)
        if ($f.Length -lt 3) { continue }
        if (-not $fam.Contains([int]$f[1])) { continue }
        $wins++
        try {
          $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$f[0])
          $els = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
          foreach ($el in $els) {
            $scanned++
            $name = ""
            try { $name = [string]$el.Current.Name } catch { continue }
            if ($null -eq $name -or $name.Trim().Length -eq 0) { continue }
            if ($sample.Count -lt 8) {
              $sample += [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name.Substring(0, [Math]::Min(24, $name.Length))))
            }
            if ($name.IndexOf($needle) -lt 0) { continue }
            $px = 0; $py = 0
            try {
              $pt = $el.GetClickablePoint()
              $px = [int]$pt.X; $py = [int]$pt.Y
            } catch {
              try {
                $rc = $el.Current.BoundingRectangle
                if ($rc.Width -gt 0 -and $rc.Height -gt 0) {
                  $px = [int]($rc.X + $rc.Width / 2); $py = [int]($rc.Y + $rc.Height / 2)
                }
              } catch { }
            }
            if ($px -gt 0 -and $py -gt 0) {
              $found += @{
                hwnd = [int64]$f[0]
                x = $px; y = $py
                name = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name))
              }
              if ($found.Count -ge 5) { break }
            }
          }
        } catch { }
      }
      if ($found.Count -eq 0 -and $attempt -lt $script:UIA_TRIES) { Start-Sleep -Milliseconds $script:UIA_STEP }
    }
    Emit @{ ok = $true; attempt = $attempt; windows = $wins; scanned = $scanned; count = $found.Count; pids = @($fam | Sort-Object); hits = $found; sample = $sample }
  }

  # ---------------------------------------------------------------- ocr
  #
  # Strategy S3: run the built-in Windows OCR (WinRT Windows.Media.Ocr) on a
  # PNG and return the bounding boxes of every text line that contains the
  # decoded $Target text, plus a sample of all recognized lines for debugging.
  #
  # Read-only. Needs the Chinese OCR language pack; when it is missing the
  # result is error = "no-chinese-ocr" so the caller can tell the user exactly
  # what to install instead of guessing.
  #
  # The WinRT async dance (Await) is the standard PowerShell 5.1 trick:
  # project the IAsyncOperation to a Task via WindowsRuntimeSystemExtensions.
  "ocr" {
    if ($File -eq "" -or -not (Test-Path $File)) { Emit @{ ok = $false; error = "no-file" }; return }
    $needle = ""
    try { $needle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Target)) } catch { }
    if ($needle -eq "") { Emit @{ ok = $false; error = "bad-args" }; return }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                     $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    function Await($op, $t) {
      $m = $asTaskGeneric.MakeGenericMethod($t)
      $task = $m.Invoke($null, @($op))
      $task.Wait(-1) | Out-Null
      $task.Result
    }

    $lang = $null
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
      if ($l.LanguageTag -like 'zh*') { $lang = $l; break }
    }
    if (-not $lang) { Emit @{ ok = $false; error = "no-chinese-ocr" }; return }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if (-not $engine) { Emit @{ ok = $false; error = "no-engine" }; return }

    # Decode the PNG with GDI+ and hand raw BGRA pixels to WinRT -- avoids the
    # WinRT stream/decoder async dance entirely.
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $File
    $w = $bmp.Width; $h = $bmp.Height
    $maxd = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($w -gt $maxd -or $h -gt $maxd) { $bmp.Dispose(); Emit @{ ok = $false; error = "too-big"; max = $maxd }; return }
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $bytes = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($data)
    $bmp.Dispose()
    if ($stride -ne $w * 4) { Emit @{ ok = $false; error = "stride" }; return }

    $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    $soft = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buf,
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $w, $h)
    $result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])

    $hits = @()
    $sample = @()
    $lc = 0
    foreach ($line in $result.Lines) {
      $lc++
      if ($sample.Count -lt 20 -and $line.Words.Count -gt 0) {
        # Indexing a WinRT IReadOnlyList directly ($line.Words[0]) hands back
        # the whole list from PowerShell 5.1 -- the cast to Int32 then fails
        # with "cannot convert System.Object[]". Materialise it first.
        $ws = @($line.Words)
        $r0 = $ws[0].BoundingRect
        $sample += @{
          t = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line.Text))
          x = [int]$r0.X; y = [int]$r0.Y
        }
      }
      $flat = $line.Text -replace '\s', ''
      if ($flat.IndexOf($needle) -lt 0) { continue }
      $x0 = 0.0; $y0 = 0.0; $x1 = 0.0; $y1 = 0.0; $first = $true
      foreach ($wrd in $line.Words) {
        $r = $wrd.BoundingRect
        if ($first) {
          $x0 = $r.X; $y0 = $r.Y; $x1 = $r.X + $r.Width; $y1 = $r.Y + $r.Height
          $first = $false
        } else {
          if ($r.X -lt $x0) { $x0 = $r.X }
          if ($r.Y -lt $y0) { $y0 = $r.Y }
          if (($r.X + $r.Width) -gt $x1) { $x1 = $r.X + $r.Width }
          if (($r.Y + $r.Height) -gt $y1) { $y1 = $r.Y + $r.Height }
        }
      }
      if (-not $first) {
        $hits += @{
          t = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line.Text))
          x = [int](($x0 + $x1) / 2); y = [int](($y0 + $y1) / 2)
          w = [int]($x1 - $x0); h = [int]($y1 - $y0)
        }
        if ($hits.Count -ge 5) { break }
      }
    }
    Emit @{ ok = $true; lang = $lang.LanguageTag; lineCount = $lc; count = $hits.Count; hits = $hits; lines = $sample }
  }

  default { Emit @{ ok = $false; error = "unknown-action" } }
}

}   # end of Invoke-Action

# ------------------------------------------------------------------- run mode
#
# Resident: one JSON request per line. Anything unparseable replies with an
# error and keeps serving -- a bad line must never take the worker down, or the
# app would lose its helper over a single malformed request.
#
# The loop ends only when ReadLine returns $null, i.e. Node closed stdin. That
# is the one and only shutdown signal, so there is no state to leak: the process
# exits by falling off the end of this script.
if ($script:SERVE) {
  $script:BOOT = $script:WORKER_START
  while ($true) {
    $line = $null
    try { $line = $script:PIPE_IN.ReadLine() } catch { break }
    if ($null -eq $line) { break }
    if ($line.Trim() -eq "") { continue }

    $script:REQ_ID = $null
    $req = $null
    try {
      $req = $line | ConvertFrom-Json
    } catch {
      Emit @{ ok = $false; error = "bad-request" }
      continue
    }
    try {
      if ($null -ne $req.id) { $script:REQ_ID = [int]$req.id }
      $act = ""
      if ($null -ne $req.a) { $act = [string]$req.a }
      if ($act -eq "") { Emit @{ ok = $false; error = "unknown-action" }; continue }
      Invoke-Action $act $req.o
    } catch {
      Emit-Exception $_
    }
  }
  exit 0
}

# One-shot: rebuild the request shape from the parameters so there is exactly
# one action implementation, then run it. Falling off the end exits with 0,
# which is what the old `exit 0` at the end of every branch did.
$oneShot = @{
  out = $Out; wait = $WaitMs; x = $X; y = $Y; keys = $Keys
  target = $Target; targetpid = $TargetPid; pids = $Pids; file = $File
  hwnd = $Hwnd; win = $Win; poll = $PollMs; full = ([bool]$Full)
  ready = [bool]$Ready
}
if ($Action -eq "") { $Action = "unknown-action" }
try { Invoke-Action $Action $oneShot } catch { Emit-Exception $_ }
