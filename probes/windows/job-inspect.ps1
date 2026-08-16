# Probe helper — ticket #43.
#
# Two things Bun cannot ask Windows for by itself:
#
#   -Mode flags       Read the LimitFlags of the job object the CALLING process
#                     is already in. Run this as a Bun-spawned child and it
#                     reports the job Bun built, which is the only way to know
#                     whether JOB_OBJECT_LIMIT_BREAKAWAY_OK is set rather than
#                     inferring it from whether an escape happened to work.
#
#   -Mode breakaway   Launch a process with CREATE_BREAKAWAY_FROM_JOB. If the
#                     job forbids breakaway this fails with ERROR_ACCESS_DENIED
#                     (5), which is the negative control: the call is genuinely
#                     attempted and genuinely refused, not skipped.
#
# Prints `KEY=VALUE` lines only. The caller parses; this script never rules.

param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Exe = "",
  [string]$Arguments = ""
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class BrigJob {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, int len, out int returned);

    // Every field is a pointer or an integer. The first revision declared the
    // three reserved members as `string`, which marshals a struct-default ANSI
    // pointer into a CharSet.Unicode call and handed CreateProcessW a garbage
    // lpDesktop — observed as ERROR_INVALID_NAME (123), which reads exactly like
    // a malformed command line and is not that.
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb; public IntPtr res1; public IntPtr desktop; public IntPtr title;
        public int x; public int y; public int xs; public int ys; public int xcc; public int ycc;
        public int fill; public int flags; public short showWindow; public short res2;
        public IntPtr res3; public IntPtr stdIn; public IntPtr stdOut; public IntPtr stdErr;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess; public IntPtr hThread; public int pid; public int tid;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcessW(
        string applicationName, string commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
}
"@

# JOBOBJECT_EXTENDED_LIMIT_INFORMATION begins with JOBOBJECT_BASIC_LIMIT_INFORMATION,
# whose first two members are 8-byte LARGE_INTEGERs, so LimitFlags sits at offset 16
# on every architecture. Reading the one field beats declaring the whole struct.
$JobObjectExtendedLimitInformation = 9
$LimitFlagsOffset = 16

$FLAGS = @{
  "JOB_OBJECT_LIMIT_WORKINGSET"                 = 0x00000001
  "JOB_OBJECT_LIMIT_PROCESS_TIME"               = 0x00000002
  "JOB_OBJECT_LIMIT_JOB_TIME"                   = 0x00000004
  "JOB_OBJECT_LIMIT_ACTIVE_PROCESS"             = 0x00000008
  "JOB_OBJECT_LIMIT_AFFINITY"                   = 0x00000010
  "JOB_OBJECT_LIMIT_PRIORITY_CLASS"             = 0x00000020
  "JOB_OBJECT_LIMIT_PRESERVE_JOB_TIME"          = 0x00000040
  "JOB_OBJECT_LIMIT_SCHEDULING_CLASS"           = 0x00000080
  "JOB_OBJECT_LIMIT_PROCESS_MEMORY"             = 0x00000100
  "JOB_OBJECT_LIMIT_JOB_MEMORY"                 = 0x00000200
  "JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION" = 0x00000400
  "JOB_OBJECT_LIMIT_BREAKAWAY_OK"               = 0x00000800
  "JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK"        = 0x00001000
  "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"          = 0x00002000
  "JOB_OBJECT_LIMIT_SUBSET_AFFINITY"            = 0x00004000
}

if ($Mode -eq "flags") {
  $inJob = $false
  $ok = [BrigJob]::IsProcessInJob([BrigJob]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)
  Write-Output ("IS_PROCESS_IN_JOB_CALL_OK=" + $ok)
  Write-Output ("IN_JOB=" + $inJob)

  if (-not $inJob) {
    # Not a failure to report as one: it means the parent never built a job, and
    # every containment claim that rests on the job is then vacuous here.
    Write-Output "LIMIT_FLAGS=none"
    Write-Output "NOTE=caller is not in any job object"
    exit 0
  }

  # QueryInformationJobObject is length-sensitive and the required length differs
  # by info class and architecture, so try each candidate and report the rc and
  # the error for every attempt rather than one opaque failure. Class 2 is
  # JobObjectBasicLimitInformation, whose LimitFlags sits at the same offset —
  # if the extended class is refused, the basic one still answers the question.
  $attempts = @(
    @{ cls = $JobObjectExtendedLimitInformation; name = "extended"; size = 144 },
    @{ cls = $JobObjectExtendedLimitInformation; name = "extended"; size = 112 },
    @{ cls = $JobObjectExtendedLimitInformation; name = "extended"; size = 256 },
    @{ cls = 2;                                  name = "basic";    size = 48  },
    @{ cls = 2;                                  name = "basic";    size = 64  }
  )

  $limitFlags = $null
  foreach ($a in $attempts) {
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($a.size)
    try {
      [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, 0, 0)
      $ret = 0
      $q = [BrigJob]::QueryInformationJobObject([IntPtr]::Zero, $a.cls, $buf, $a.size, [ref]$ret)
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Output ("QUERY_ATTEMPT_" + $a.name + "_" + $a.size + "=ok=" + $q + ",err=" + $err + ",returned=" + $ret)
      if ($q -and $limitFlags -eq $null) {
        $limitFlags = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $LimitFlagsOffset)
        Write-Output ("QUERY_WON=" + $a.name + "/" + $a.size)
      }
    } finally {
      [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    }
  }

  if ($limitFlags -eq $null) {
    Write-Output "QUERY_OK=False"
    Write-Output "LIMIT_FLAGS=unreadable"
    exit 0
  }

  Write-Output ("QUERY_OK=True")
  Write-Output ("LIMIT_FLAGS=0x{0:X8}" -f $limitFlags)
  foreach ($k in ($FLAGS.Keys | Sort-Object)) {
    $set = ($limitFlags -band $FLAGS[$k]) -ne 0
    Write-Output ("FLAG_${k}=" + $set)
  }
  exit 0
}

if ($Mode -eq "breakaway") {
  $CREATE_BREAKAWAY_FROM_JOB = 0x01000000
  $CREATE_NEW_CONSOLE       = 0x00000010
  $DETACHED_PROCESS         = 0x00000008

  $si = New-Object BrigJob+STARTUPINFO
  $si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
  $pi = New-Object BrigJob+PROCESS_INFORMATION

  # CreateProcessW mutates the command-line buffer, and the exe path may contain
  # spaces, so quote it explicitly. lpApplicationName is passed as well, which
  # removes the command-line search heuristic from the picture entirely — the
  # only thing left that can fail is the breakaway itself, which is the point.
  $cmdline = '"' + $Exe + '" ' + $Arguments
  Write-Output ("CREATEPROCESS_EXE=" + $Exe)
  Write-Output ("CREATEPROCESS_CMDLINE=" + $cmdline)

  # Run the same call twice: once asking to break away, once not. Without the
  # control, "it failed" and "this call never works here" look identical.
  $trials = @(
    @{ name = "with_breakaway";    flags = ($CREATE_BREAKAWAY_FROM_JOB -bor $DETACHED_PROCESS) },
    @{ name = "without_breakaway"; flags = $DETACHED_PROCESS }
  )

  foreach ($t in $trials) {
    $si2 = New-Object BrigJob+STARTUPINFO
    $si2.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si2)
    $pi2 = New-Object BrigJob+PROCESS_INFORMATION
    $ok = [BrigJob]::CreateProcessW($Exe, $cmdline, [IntPtr]::Zero, [IntPtr]::Zero, $false, $t.flags, [IntPtr]::Zero, $null, [ref]$si2, [ref]$pi2)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()

    Write-Output ("CREATEPROCESS_" + $t.name + "_OK=" + $ok)
    Write-Output ("CREATEPROCESS_" + $t.name + "_LAST_ERROR=" + $err)
    Write-Output ("CREATEPROCESS_" + $t.name + "_PID=" + $pi2.pid)

    if (-not $ok) {
      # 5 == ERROR_ACCESS_DENIED, which is exactly what a job without
      # JOB_OBJECT_LIMIT_BREAKAWAY_OK returns. Anything else is a different
      # story and must not be reported as "breakaway blocked".
      $interp = if ($err -eq 5) { "ACCESS_DENIED_breakaway_forbidden" } else { "other_failure_err_$err" }
    } else {
      $interp = "launched"
    }
    Write-Output ("CREATEPROCESS_" + $t.name + "_INTERPRETATION=" + $interp)

    # Only the breakaway trial may leave a live grandchild behind. The control
    # is given long enough to write one heartbeat — so the caller's "did it ever
    # start" precondition is satisfied either way — and is then killed, so a
    # contained process can never be counted as an escape.
    if ($ok -and $t.name -eq "without_breakaway") {
      Start-Sleep -Milliseconds 1500
      try { Stop-Process -Id $pi2.pid -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  exit 0
}

Write-Output "ERROR=unknown mode $Mode"
exit 2
