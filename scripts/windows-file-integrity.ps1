# Read-only Windows mandatory-integrity inspection. Input: a JSON array of
# absolute file/directory paths on stdin. Output: one JSON object on stdout.
# No privilege adjustment or security-descriptor mutation is performed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

try {
    # Redirected stdin/stdout from Node are UTF-8, not the machine's OEM codepage.
    $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace LogiNote.ReadOnlySecurity
{
    public static class Integrity
    {
        private const uint LabelSecurityInformation = 0x00000010;
        private const uint TokenQuery = 0x0008;
        private const int TokenIntegrityLevel = 25;
        private const int ErrorInsufficientBuffer = 122;
        private const byte MandatoryLabelAceType = 0x11;
        private const uint MediumIntegrityRid = 8192;

        [StructLayout(LayoutKind.Sequential)]
        private struct AclSizeInformation
        {
            public uint AceCount;
            public uint AclBytesInUse;
            public uint AclBytesFree;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint GetNamedSecurityInfoW(string objectName, int objectType,
            uint securityInformation, out IntPtr owner, out IntPtr group,
            out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetAclInformation(IntPtr acl, out AclSizeInformation information,
            uint informationLength, int informationClass);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetAce(IntPtr acl, uint aceIndex, out IntPtr ace);

        [DllImport("advapi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsValidAcl(IntPtr acl);

        [DllImport("advapi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsValidSid(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern uint GetLengthSid(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(IntPtr token, int informationClass,
            IntPtr information, uint informationLength, out uint returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        private static uint RidFromSid(IntPtr sid)
        {
            if (sid == IntPtr.Zero || !IsValidSid(sid))
                throw new InvalidOperationException("Invalid integrity-label SID.");
            IntPtr countPointer = GetSidSubAuthorityCount(sid);
            if (countPointer == IntPtr.Zero)
                throw new InvalidOperationException("Missing integrity SID subauthority count.");
            byte count = Marshal.ReadByte(countPointer);
            if (count == 0) throw new InvalidOperationException("Integrity SID has no RID.");
            IntPtr ridPointer = GetSidSubAuthority(sid, (uint)(count - 1));
            if (ridPointer == IntPtr.Zero)
                throw new InvalidOperationException("Missing integrity SID RID.");
            return unchecked((uint)Marshal.ReadInt32(ridPointer));
        }

        public static uint FileIntegrityRid(string path)
        {
            IntPtr owner, group, dacl, sacl, descriptor;
            uint result = GetNamedSecurityInfoW(path, 1, LabelSecurityInformation,
                out owner, out group, out dacl, out sacl, out descriptor);
            try
            {
                if (result != 0) throw new Win32Exception((int)result, "Cannot query integrity label: " + path);
                if (sacl == IntPtr.Zero) return MediumIntegrityRid;
                if (!IsValidAcl(sacl)) throw new InvalidOperationException("Invalid label ACL: " + path);
                AclSizeInformation information;
                if (!GetAclInformation(sacl, out information,
                    (uint)Marshal.SizeOf(typeof(AclSizeInformation)), 2))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect label ACL: " + path);
                bool found = false;
                uint labelRid = MediumIntegrityRid;
                for (uint i = 0; i < information.AceCount; i++)
                {
                    IntPtr ace;
                    if (!GetAce(sacl, i, out ace))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect label ACE: " + path);
                    if (ace == IntPtr.Zero) throw new InvalidOperationException("Missing label ACE: " + path);
                    if (Marshal.ReadByte(ace) != MandatoryLabelAceType) continue;
                    // SYSTEM_MANDATORY_LABEL_ACE: header (4), mask (4), SID.
                    ushort aceSize = unchecked((ushort)Marshal.ReadInt16(ace, 2));
                    if (aceSize < 20) throw new InvalidOperationException("Truncated integrity ACE: " + path);
                    IntPtr sid = IntPtr.Add(ace, 8);
                    if (!IsValidSid(sid) || GetLengthSid(sid) > (uint)(aceSize - 8))
                        throw new InvalidOperationException("Invalid integrity ACE SID: " + path);
                    uint rid = RidFromSid(sid);
                    if (found && labelRid != rid)
                        throw new InvalidOperationException("Conflicting integrity labels: " + path);
                    found = true;
                    labelRid = rid;
                }
                // Only an absent mandatory-label ACE defaults to Medium.
                return found ? labelRid : MediumIntegrityRid;
            }
            finally
            {
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }

        public static uint ProcessIntegrityRid()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out token))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open current process token.");
            IntPtr buffer = IntPtr.Zero;
            try
            {
                uint size;
                bool queried = GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
                int error = Marshal.GetLastWin32Error();
                if (queried || error != ErrorInsufficientBuffer || size < (uint)IntPtr.Size || size > Int32.MaxValue)
                    throw new Win32Exception(error, "Cannot determine token integrity buffer size.");
                buffer = Marshal.AllocHGlobal((int)size);
                uint returned;
                if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, size, out returned))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query current process integrity.");
                if (returned > size || returned < (uint)IntPtr.Size)
                    throw new InvalidOperationException("Invalid token integrity buffer.");
                // TOKEN_MANDATORY_LABEL begins with SID_AND_ATTRIBUTES.Sid.
                return RidFromSid(Marshal.ReadIntPtr(buffer));
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
                CloseHandle(token);
            }
        }
    }
}
'@

    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop
    $jsonInput = [Console]::In.ReadToEnd()
    if ([String]::IsNullOrWhiteSpace($jsonInput) -or $jsonInput.TrimStart()[0] -ne '[') {
        throw 'stdin must be a JSON array of absolute file or directory paths.'
    }
    $decodedPaths = ConvertFrom-Json -InputObject $jsonInput -ErrorAction Stop
    if ($jsonInput -match '\A\s*\[\s*\]\s*\z') {
        $requestedPaths = @()
    } else {
        $requestedPaths = @($decodedPaths)
    }
    $processRid = [LogiNote.ReadOnlySecurity.Integrity]::ProcessIntegrityRid()
    $fileReports = New-Object 'System.Collections.Generic.List[object]'
    foreach ($requestedPath in $requestedPaths) {
        if ($requestedPath -isnot [String] -or [String]::IsNullOrWhiteSpace($requestedPath)) {
            throw 'Every input array entry must be a nonempty absolute path string.'
        }
        # Reject drive-relative (C:foo) and current-drive-relative (\foo) paths.
        # Accept rooted drive paths and fully qualified UNC/device paths.
        if ($requestedPath -notmatch '\A(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|\z))') {
            throw ('Input path is not absolute: ' + $requestedPath)
        }
        $absolutePath = [System.IO.Path]::GetFullPath($requestedPath)
        $rid = [LogiNote.ReadOnlySecurity.Integrity]::FileIntegrityRid($absolutePath)
        $fileReports.Add([PSCustomObject]@{ path = $absolutePath; integrityRid = $rid })
    }
    $report = [Ordered]@{ processIntegrityRid = $processRid; files = @($fileReports.ToArray()) }
    [Console]::Out.WriteLine(($report | ConvertTo-Json -Depth 5 -Compress))
    exit 0
} catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $failureText = 'windows-file-integrity: ' + $failure.Message
    if ($failure -is [System.ComponentModel.Win32Exception]) {
        $failureText += ' (Win32 error ' + $failure.NativeErrorCode + ')'
    }
    [Console]::Error.WriteLine($failureText)
    exit 1
}
