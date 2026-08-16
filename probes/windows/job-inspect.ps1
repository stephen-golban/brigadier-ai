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
    public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, int len, IntPtr returned);

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb; public string res1; public string desktop; public string title;
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

  $size = 256
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    $q = [BrigJob]::QueryInformationJobObject([IntPtr]::Zero, $JobObjectExtendedLimitInformation, $buf, $size, [IntPtr]::Zero)
    if (-not $q) {
      Write-Output ("QUERY_OK=False")
      Write-Output ("QUERY_LAST_ERROR=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
      exit 0
    }
    $limitFlags = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $LimitFlagsOffset)
    Write-Output ("QUERY_OK=True")
    Write-Output ("LIMIT_FLAGS=0x{0:X8}" -f $limitFlags)
    foreach ($k in ($FLAGS.Keys | Sort-Object)) {
      $set = ($limitFlags -band $FLAGS[$k]) -ne 0
      Write-Output ("FLAG_${k}=" + $set)
    }
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
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
  # spaces, so quote it explicitly rather than relying on the search heuristic.
  $cmdline = '"' + $Exe + '" ' + $Arguments

  $flags = $CREATE_BREAKAWAY_FROM_JOB -bor $DETACHED_PROCESS
  $ok = [BrigJob]::CreateProcessW($null, $cmdline, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, [IntPtr]::Zero, $null, [ref]$si, [ref]$pi)
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()

  Write-Output ("CREATEPROCESS_BREAKAWAY_OK=" + $ok)
  Write-Output ("CREATEPROCESS_LAST_ERROR=" + $err)
  Write-Output ("CREATEPROCESS_PID=" + $pi.pid)

  if (-not $ok) {
    # 5 == ERROR_ACCESS_DENIED, which is exactly what a job without
    # JOB_OBJECT_LIMIT_BREAKAWAY_OK returns. Anything else is a different story
    # and must not be reported as "breakaway blocked".
    Write-Output ("CREATEPROCESS_INTERPRETATION=" + $(if ($err -eq 5) { "ACCESS_DENIED_breakaway_forbidden" } else { "other_failure" }))
  } else {
    Write-Output "CREATEPROCESS_INTERPRETATION=launched_outside_job"
  }
  exit 0
}

Write-Output "ERROR=unknown mode $Mode"
exit 2
