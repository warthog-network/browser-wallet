/* Chrome cannot start a .bat native host. This program starts the Python host
   and passes the native-messaging pipes through. */
#define WIN32_LEAN_AND_MEAN
#include <wchar.h>
#include <windows.h>

static int fail(const wchar_t *message) {
    HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
    char bytes[320];
    int count;
    DWORD wrote;
    if (!err || err == INVALID_HANDLE_VALUE) return 1;
    count = WideCharToMultiByte(CP_UTF8, 0, message, -1, bytes, sizeof bytes, NULL, NULL);
    if (count > 1) WriteFile(err, bytes, (DWORD)(count - 1), &wrote, NULL);
    return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show) {
    wchar_t dir[1024];
    wchar_t script[1200];
    wchar_t python[1024];
    wchar_t cmdline[2400];
    const wchar_t *flags;
    DWORD length;
    DWORD found;
    wchar_t *slash;
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    DWORD code = 1;
    (void)instance;
    (void)previous;
    (void)command;
    (void)show;

    length = GetModuleFileNameW(NULL, dir, 1024);
    if (!length || length >= 1024) return fail(L"The IPv4 forwarder could not find its folder.\n");
    slash = wcsrchr(dir, L'\\');
    if (!slash) return fail(L"The IPv4 forwarder could not find its folder.\n");
    *slash = 0;
    if (swprintf(script, 1200, L"%s\\scripts\\safetrade-native-host.py", dir) < 0)
        return fail(L"The IPv4 forwarder could not find its host script.\n");
    if (GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES)
        return fail(L"safetrade-native-host.py is missing beside this program.\n");

    found = SearchPathW(NULL, L"py.exe", NULL, 1024, python, NULL);
    flags = L"-3 -u";
    if (!found || found >= 1024) {
        found = SearchPathW(NULL, L"python.exe", NULL, 1024, python, NULL);
        flags = L"-u";
    }
    if (!found || found >= 1024)
        return fail(L"Python was not found on PATH. Install Python 3, then run the installer again.\n");
    if (swprintf(cmdline, 2400, L"\"%s\" %s \"%s\"", python, flags, script) < 0)
        return fail(L"The IPv4 forwarder could not start Python.\n");

    ZeroMemory(&startup, sizeof startup);
    ZeroMemory(&process, sizeof process);
    startup.cb = sizeof startup;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (startup.hStdInput && startup.hStdInput != INVALID_HANDLE_VALUE)
        SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    if (startup.hStdOutput && startup.hStdOutput != INVALID_HANDLE_VALUE)
        SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    if (startup.hStdError && startup.hStdError != INVALID_HANDLE_VALUE)
        SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    if (!CreateProcessW(python, cmdline, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, dir, &startup, &process))
        return fail(L"The IPv4 forwarder could not start Python.\n");
    WaitForSingleObject(process.hProcess, INFINITE);
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return (int)code;
}
