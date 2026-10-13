using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Shadow {
    public sealed class WhatsAppResult {
        public bool ok { get; set; }
        public string code { get; set; }
        public string stage { get; set; }
        public WhatsAppDiagnostics diagnostics { get; set; }
    }
    public sealed class WhatsAppDiagnostics {
        public int helperVersion { get; set; }
        public int appProcesses { get; set; }
        public int appWindows { get; set; }
        public int inaccessibleWindows { get; set; }
        public bool minimized { get; set; }
        public bool search { get; set; }
        public bool composer { get; set; }
        public bool voiceCall { get; set; }
        public bool videoCall { get; set; }
        public bool voiceInvoke { get; set; }
        public bool videoInvoke { get; set; }
    }
    // All selectors refer to WhatsApp's own accessibility tree. No screen-coordinate clicks.
    public static class WhatsAppDesktop {
        static readonly string[] SearchNames = { "Search", "Search or start new chat", "Search chats", "Search or start a new chat", "Search input textbox" };
        static readonly string[] ComposeNames = { "Type a message", "Message", "Enter a message", "Message input" };
        static readonly string[] VoiceNames = { "Voice call", "Audio call", "Start voice call", "Start audio call" };
        static readonly string[] VideoNames = { "Video call", "Start video call" };
        static readonly string[] EndNames = { "End call", "Hang up", "Cancel call" };
        static readonly string[] SendNames = { "Send", "Send message" };
        static readonly string[] InfoNames = { "Contact info", "Chat info", "Open contact info", "View contact info", "Open chat info", "Profile details", "Contact details" };
        sealed class Failure : Exception {
            public readonly string Code;
            public Failure(string code) { Code = code; }
        }
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint id);
        delegate bool WindowCallback(IntPtr handle, IntPtr state);
        [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder title, int count);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder name);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
        [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x, y; public uint data, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort key, scan; public uint flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Explicit)] struct InputData {
            [FieldOffset(0)] public MouseInput mouse;
            [FieldOffset(0)] public KeyInput keyboard;
        }
        [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputData data; }

        static WhatsAppResult Result(bool ok, string code) { return new WhatsAppResult { ok = ok, code = code }; }
        static bool Same(string a, string b) { return String.Equals((a ?? "").Trim(), (b ?? "").Trim(), StringComparison.OrdinalIgnoreCase); }
        static bool HasName(AutomationElement e, string[] names) {
            foreach (string name in names) if (Same(e.Current.Name, name)) return true;
            return false;
        }
        static bool Usable(AutomationElement e) { return e.Current.IsEnabled && !e.Current.IsOffscreen && !e.Current.BoundingRectangle.IsEmpty; }
        static AutomationElement[] Elements(AutomationElement root) {
            var found = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            var list = new List<AutomationElement>();
            foreach (AutomationElement e in found) list.Add(e);
            return list.ToArray();
        }
        static AutomationElement Find(AutomationElement root, ControlType type, string[] names) {
            var controls = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, type));
            foreach (AutomationElement e in controls)
                if (Usable(e) && HasName(e, names)) return e;
            return null;
        }
        static AutomationElement Composer(AutomationElement root) {
            var types = new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Custom));
            foreach (AutomationElement e in root.FindAll(TreeScope.Descendants, types)) {
                if (!Usable(e) || !HasName(e, ComposeNames)) continue;
                object pattern;
                bool readable = e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || e.TryGetCurrentPattern(TextPattern.Pattern, out pattern);
                if (readable && e.Current.IsKeyboardFocusable) return e;
            }
            return null;
        }
        static bool Invokable(AutomationElement element) {
            object pattern;
            return element != null && element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern);
        }
        public static bool KnownProcessName(string name) {
            return Same(name, "WhatsApp") || Same(name, "WhatsAppBeta") || Same(name, "WhatsApp.Root") || Same(name, "WhatsApp Desktop");
        }
        public static bool KnownPackage(string name) {
            return Same(name, "5319275A.WhatsAppDesktop_cv1g1gvanyjgm") || Same(name, "5319275A.WhatsAppBeta_cv1g1gvanyjgm") || Same(name, "5319275A.WhatsApp_cv1g1gvanyjgm");
        }
        static bool WhatsAppProcess(int id) {
            try {
                string name;
                using (var process = Process.GetProcessById(id)) name = process.ProcessName;
                if (KnownProcessName(name)) return true;
                IntPtr handle = OpenProcess(0x1000, false, (uint)id);
                if (handle == IntPtr.Zero) return false;
                try {
                    uint length = 256;
                    var family = new StringBuilder((int)length);
                    return GetPackageFamilyName(handle, ref length, family) == 0 && KnownPackage(family.ToString());
                } finally { CloseHandle(handle); }
            } catch { return false; }
        }
        static bool WhatsAppWindow(AutomationElement root) {
            if (WhatsAppProcess(root.Current.ProcessId)) return true;
            uint nativeId;
            GetWindowThreadProcessId(new IntPtr(root.Current.NativeWindowHandle), out nativeId);
            if (nativeId != 0 && WhatsAppProcess((int)nativeId)) return true;
            try {
                using (var process = Process.GetProcessById(root.Current.ProcessId))
                    if (!Same(process.ProcessName, "ApplicationFrameHost")) return false;
                foreach (AutomationElement e in Elements(root)) if (WhatsAppProcess(e.Current.ProcessId)) return true;
            } catch { }
            return false;
        }
        sealed class AppWindow {
            public IntPtr Handle;
            public AutomationElement Root;
            public bool MainTitle, HasSearch, Owned, HasCall;
        }
        public static bool MainWindowCandidate(bool hasSearch, bool mainTitle, bool owned, bool hasCall) {
            return !hasCall && (hasSearch || (mainTitle && !owned));
        }
        static List<AppWindow> Windows(WhatsAppDiagnostics diagnostics = null) {
            var found = new List<AppWindow>();
            // Native windows can be exposed as UIA Pane/Custom instead of Window in WebView versions.
            EnumWindows((handle, state) => {
                if (!IsWindowVisible(handle)) return true;
                uint id;
                GetWindowThreadProcessId(handle, out id);
                bool ownedProcess = WhatsAppProcess((int)id);
                // Do not inspect browsers just because their page title mentions WhatsApp.
                if (!ownedProcess) {
                    try {
                        using (var process = Process.GetProcessById((int)id))
                            if (!Same(process.ProcessName, "ApplicationFrameHost")) return true;
                    } catch { return true; }
                }
                try {
                    var root = AutomationElement.FromHandle(handle);
                    if (root == null || (!ownedProcess && !WhatsAppWindow(root))) return true;
                    if (diagnostics != null) diagnostics.appWindows++;
                    var title = new StringBuilder(512);
                    GetWindowText(handle, title, title.Capacity);
                    bool mainTitle = title.ToString().IndexOf("WhatsApp", StringComparison.OrdinalIgnoreCase) >= 0;
                    // A minimized provider may not expose its controls until the window is restored.
                    bool minimized = IsIconic(handle);
                    bool hasSearch = !minimized && Find(root, ControlType.Edit, SearchNames) != null;
                    found.Add(new AppWindow { Handle = handle, Root = root, MainTitle = mainTitle,
                        HasSearch = hasSearch, Owned = GetWindow(handle, 4) != IntPtr.Zero,
                        HasCall = !minimized && Find(root, ControlType.Button, EndNames) != null });
                } catch {
                    if (ownedProcess && diagnostics != null) diagnostics.inaccessibleWindows++;
                    // One inaccessible window must not hide another valid WhatsApp window.
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }
        static List<AppWindow> MainWindows(List<AppWindow> windows) {
            var candidates = new List<AppWindow>();
            var accessible = new List<AppWindow>();
            foreach (var window in windows) {
                if (!MainWindowCandidate(window.HasSearch, window.MainTitle, window.Owned, window.HasCall)) continue;
                candidates.Add(window);
                if (window.HasSearch) accessible.Add(window);
            }
            // Prefer the chat window over notification or startup windows bearing the app title.
            return accessible.Count > 0 ? accessible : candidates;
        }
        static AppWindow Window() {
            var found = MainWindows(Windows());
            if (found.Count > 1) throw new Failure("multiple_windows");
            return found.Count == 1 ? found[0] : null;
        }
        static bool CallActive() {
            foreach (var window in Windows()) if (window.HasCall) return true;
            return false;
        }
        static int RunningProcesses() {
            int count = 0;
            foreach (var process in Process.GetProcesses()) {
                try { if (WhatsAppProcess(process.Id)) count++; }
                finally { process.Dispose(); }
            }
            return count;
        }
        static WhatsAppResult Status() {
            // Report only counters and known-control presence. Never return window titles, names or chat text.
            var diagnostics = new WhatsAppDiagnostics { helperVersion = 3, appProcesses = RunningProcesses() };
            var result = Result(false, "helper_error");
            result.stage = "status";
            result.diagnostics = diagnostics;
            try {
                var windows = Windows(diagnostics);
                var found = MainWindows(windows);
                if (found.Count > 1) result.code = "multiple_windows";
                else if (found.Count == 0) result.code = diagnostics.appProcesses > 0 ? "window_unavailable" : "not_running";
                else {
                    var window = found[0];
                    diagnostics.minimized = IsIconic(window.Handle);
                    diagnostics.search = window.HasSearch;
                    if (!diagnostics.minimized) {
                        diagnostics.composer = Composer(window.Root) != null;
                        var voice = Find(window.Root, ControlType.Button, VoiceNames);
                        var video = Find(window.Root, ControlType.Button, VideoNames);
                        diagnostics.voiceCall = voice != null;
                        diagnostics.videoCall = video != null;
                        diagnostics.voiceInvoke = Invokable(voice);
                        diagnostics.videoInvoke = Invokable(video);
                    }
                    result.code = diagnostics.minimized ? "minimized" : diagnostics.search ? "ready" : "controls_unavailable";
                    result.ok = result.code == "ready";
                }
                foreach (var window in windows) if (window.HasCall) {
                    result.ok = false;
                    result.code = "call_active";
                    break;
                }
            } catch { result.code = "helper_error"; }
            return result;
        }
        static T Wait<T>(Func<T> check, int ms) where T : class {
            var clock = Stopwatch.StartNew();
            do {
                T value = check();
                if (value != null) return value;
                Thread.Sleep(100);
            } while (clock.ElapsedMilliseconds < ms);
            return null;
        }
        static void AssertWindow(AppWindow window) {
            uint id;
            GetWindowThreadProcessId(window.Handle, out id);
            if (!IsWindow(window.Handle) || (!WhatsAppProcess((int)id) && !WhatsAppWindow(window.Root))) throw new Failure("unavailable");
            if (GetForegroundWindow() != window.Handle) throw new Failure("focus_changed");
        }
        static bool ModalOpen(AutomationElement root) {
            foreach (var e in Elements(root)) {
                if (!Usable(e)) continue;
                object raw;
                if (e.TryGetCurrentPattern(WindowPattern.Pattern, out raw) && ((WindowPattern)raw).Current.IsModal) return true;
                if (Same(e.Current.AutomationId, "ContentDialog")) return true;
            }
            return false;
        }
        static void Focus(AppWindow window, AutomationElement target) {
            AssertWindow(window);
            target.SetFocus();
            Thread.Sleep(60);
            if (!Automation.Compare(target, AutomationElement.FocusedElement)) throw new Failure("focus_changed");
        }
        static Input Key(ushort code, bool up, bool unicode) {
            var value = new Input { type = 1 };
            value.data.keyboard = new KeyInput { key = unicode ? (ushort)0 : code, scan = unicode ? code : (ushort)0, flags = (unicode ? 4u : 0u) | (up ? 2u : 0u) };
            return value;
        }
        static void SendKeys(AppWindow window, AutomationElement edit, Input[] inputs) {
            AssertWindow(window);
            if (!Automation.Compare(edit, AutomationElement.FocusedElement)) throw new Failure("focus_changed");
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length) throw new Failure("controls_unavailable");
        }
        static void Write(AppWindow window, AutomationElement edit, string text) {
            AssertWindow(window);
            object raw;
            if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out raw) && !((ValuePattern)raw).Current.IsReadOnly) {
                ((ValuePattern)raw).SetValue(text);
                return;
            }
            Focus(window, edit);
            SendKeys(window, edit, new[] { Key(0x11, false, false), Key(0x41, false, false), Key(0x41, true, false), Key(0x11, true, false) });
            // Literal Unicode input; braces, quotes and shell metacharacters are never shortcuts.
            foreach (char ch in text.Replace("\r\n", "\n")) {
                if (ch == '\n') SendKeys(window, edit, new[] { Key(0x10, false, false), Key(0x0D, false, false), Key(0x0D, true, false), Key(0x10, true, false) });
                else SendKeys(window, edit, new[] { Key(ch, false, true), Key(ch, true, true) });
            }
        }
        static string Read(AutomationElement edit) {
            object raw;
            string value;
            if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out raw)) value = ((ValuePattern)raw).Current.Value;
            else if (edit.TryGetCurrentPattern(TextPattern.Pattern, out raw)) value = ((TextPattern)raw).DocumentRange.GetText(-1);
            else throw new Failure("controls_unavailable");
            return (value ?? "").Replace("\r\n", "\n").TrimEnd('\r', '\n');
        }
        static void Activate(AppWindow window, AutomationElement element) {
            AssertWindow(window);
            object raw;
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out raw)) ((InvokePattern)raw).Invoke();
            else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out raw)) ((SelectionItemPattern)raw).Select();
            else {
                Focus(window, element);
                SendKeys(window, element, new[] { Key(0x0D, false, false), Key(0x0D, true, false) });
            }
        }
        static AutomationElement Row(AutomationElement leaf, AutomationElement root) {
            var current = leaf;
            for (int depth = 0; depth < 7 && current != null && !Automation.Compare(current, root); depth++) {
                if (current.Current.ControlType == ControlType.ListItem || current.Current.ControlType == ControlType.DataItem || current.Current.ControlType == ControlType.Button) return current;
                current = TreeWalker.ControlViewWalker.GetParent(current);
            }
            return null;
        }
        static List<AutomationElement> Matches(AutomationElement root, AutomationElement search, string contact) {
            var rows = new List<AutomationElement>();
            var box = search.Current.BoundingRectangle;
            foreach (AutomationElement e in Elements(root)) {
                if (!Usable(e) || !Same(e.Current.Name, contact)) continue;
                var rect = e.Current.BoundingRectangle;
                if (rect.Top < box.Bottom || rect.Left > box.Right) continue;
                var row = Row(e, root);
                if (row == null) continue;
                bool duplicate = false;
                foreach (var previous in rows) if (Automation.Compare(previous, row)) duplicate = true;
                if (!duplicate) rows.Add(row);
            }
            return rows;
        }
        static bool HeaderControl(AutomationElement element, AutomationElement root) {
            var current = element;
            for (int i = 0; i < 4 && current != null && !Automation.Compare(current, root); i++) {
                var type = current.Current.ControlType;
                string id = current.Current.AutomationId;
                if (type == ControlType.Header || type == ControlType.Button || HasName(current, InfoNames) || Same(id, "ConversationTitle") || Same(id, "ChatHeader") || Same(id, "ContactName")) return true;
                current = TreeWalker.ControlViewWalker.GetParent(current);
            }
            return false;
        }
        public static bool InChatHeader(double left, double bottom, double sidebarRight, double headerBottom) {
            return left >= sidebarRight && bottom <= headerBottom;
        }
        static bool HeaderMatches(AutomationElement root, string contact, double sidebarRight, double headerBottom, AutomationElement compose = null) {
            foreach (AutomationElement e in Elements(root)) {
                if (!Usable(e) || !Same(e.Current.Name, contact) || !HeaderControl(e, root)) continue;
                var rect = e.Current.BoundingRectangle;
                // Verify the chat header in the message pane, never a matching message or sidebar row.
                if (!InChatHeader(rect.Left, rect.Bottom, sidebarRight, headerBottom)) continue;
                if (compose != null) {
                    var input = compose.Current.BoundingRectangle;
                    if (rect.Bottom >= input.Top || rect.Left < input.Left - 90) continue;
                }
                return true;
            }
            return false;
        }
        static void AssertRecipient(AppWindow window, string contact, double right, double headerBottom, AutomationElement compose = null) {
            AssertWindow(window);
            var root = window.Root;
            if (ModalOpen(root)) throw new Failure("dialog_open");
            if (!HeaderMatches(root, contact, right, headerBottom, compose)) throw new Failure("recipient_unverified");
        }
        static AutomationElement CallButton(AutomationElement root, string[] names, double right, double headerBottom) {
            var controls = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
            var matches = new List<AutomationElement>();
            foreach (AutomationElement e in controls) {
                if (!Usable(e) || !HasName(e, names)) continue;
                var rect = e.Current.BoundingRectangle;
                if (InChatHeader(rect.Left, rect.Bottom, right, headerBottom)) matches.Add(e);
            }
            // A sidebar or message button cannot substitute for the current chat's header button.
            return matches.Count == 1 ? matches[0] : null;
        }
        static bool ValidContact(string contact) {
            if (String.IsNullOrWhiteSpace(contact) || contact.Length > 120) return false;
            foreach (char c in contact) if (Char.IsControl(c)) return false;
            return true;
        }
        static bool ValidMessage(string message) {
            if (String.IsNullOrWhiteSpace(message) || message.Length > 4000) return false;
            foreach (char c in message) if (Char.IsControl(c) && c != '\n' && c != '\r' && c != '\t') return false;
            return true;
        }
        public static WhatsAppResult Run(string action, string contact, string message, string callType, bool waitForApp) {
            bool dispatched = false;
            string stage = "validation";
            Func<bool, string, WhatsAppResult> finish = (ok, code) => new WhatsAppResult { ok = ok, code = code, stage = stage };
            try {
                if (action != "status" && action != "send" && action != "call") return finish(false, "helper_error");
                if (action != "status" && !ValidContact(contact)) return finish(false, "helper_error");
                if (action == "send" && !ValidMessage(message)) return finish(false, "helper_error");
                if (action == "call" && callType != "voice" && callType != "video") return finish(false, "helper_error");
                if (action == "status") return Status();
                stage = "discover";
                // Detect an existing call even if it is the only WhatsApp window.
                if (CallActive()) return finish(false, "call_active");
                var window = Wait(() => Window(), waitForApp ? 6000 : 100);
                if (window == null) return finish(false, RunningProcesses() > 0 ? "window_unavailable" : "not_running");
                var root = window.Root;
                stage = "focus";
                ShowWindow(window.Handle, 9);
                SetForegroundWindow(window.Handle);
                Thread.Sleep(200);
                AssertWindow(window);
                var search = Wait(() => Find(root, ControlType.Edit, SearchNames), waitForApp ? 4000 : 1200);
                if (search == null) return finish(false, "controls_unavailable");
                if (ModalOpen(root)) return finish(false, "dialog_open");
                if (CallActive()) return finish(false, "call_active");
                stage = "search";
                double sidebarRight = search.Current.BoundingRectangle.Right;
                double headerBottom = search.Current.BoundingRectangle.Bottom + 24;
                Write(window, search, contact);
                if (Wait(() => {
                    AssertWindow(window);
                    return Read(search) == contact ? "verified" : null;
                }, 1200) == null) return finish(false, "search_unverified");
                // Wait for filtering to settle before accepting an exact, unique result.
                Thread.Sleep(800);
                List<AutomationElement> matches = null;
                Wait(() => { matches = Matches(root, search, contact); return matches.Count > 0 ? matches : null; }, 3500);
                if (matches == null || matches.Count == 0) return finish(false, "not_found");
                Thread.Sleep(250);
                matches = Matches(root, search, contact);
                if (matches.Count != 1) return finish(false, matches.Count > 1 ? "ambiguous" : "not_found");
                stage = "select_chat";
                Activate(window, matches[0]);
                stage = "verify_chat";
                if (Wait(() => {
                    AssertWindow(window);
                    if (ModalOpen(root)) throw new Failure("dialog_open");
                    return HeaderMatches(root, contact, sidebarRight, headerBottom) ? "verified" : null;
                }, 3500) == null) return finish(false, "recipient_unverified");
                AssertRecipient(window, contact, sidebarRight, headerBottom);
                if (action == "send") {
                    stage = "message_input";
                    var compose = Wait(() => Composer(root), 3500);
                    if (compose == null) return finish(false, "composer_unavailable");
                    AssertRecipient(window, contact, sidebarRight, headerBottom, compose);
                    string expected = message.Replace("\r\n", "\n");
                    string draft = Read(compose);
                    if (draft.Length > 0 && draft != expected) return finish(false, "draft_exists");
                    Write(window, compose, expected);
                    if (Wait(() => {
                        AssertRecipient(window, contact, sidebarRight, headerBottom, compose);
                        return Read(compose) == expected ? "verified" : null;
                    }, 1500) == null) return finish(false, "message_unverified");
                    AssertRecipient(window, contact, sidebarRight, headerBottom, compose);
                    stage = "send_button";
                    var send = Find(root, ControlType.Button, SendNames);
                    if (send == null) return finish(false, "send_unavailable");
                    // Sending and calling require an actual InvokePattern, never a guessed Enter key.
                    object invoke;
                    if (!send.TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) return finish(false, "send_unavailable");
                    if (Read(compose) != expected) return finish(false, "message_unverified");
                    AssertRecipient(window, contact, sidebarRight, headerBottom, compose);
                    stage = "send_message";
                    dispatched = true;
                    ((InvokePattern)invoke).Invoke();
                    stage = "confirm_send";
                    bool cleared = Wait(() => {
                        AssertRecipient(window, contact, sidebarRight, headerBottom, compose);
                        return Read(compose).Length == 0 ? "cleared" : null;
                    }, 3000) != null;
                    return finish(cleared, cleared ? "sent" : "send_uncertain");
                }
                stage = "call_button";
                var call = Wait(() => CallButton(root, callType == "voice" ? VoiceNames : VideoNames, sidebarRight, headerBottom), 1500);
                if (call == null) return finish(false, "call_unavailable");
                AssertRecipient(window, contact, sidebarRight, headerBottom);
                if (CallActive()) return finish(false, "call_active");
                object callInvoke;
                if (!call.TryGetCurrentPattern(InvokePattern.Pattern, out callInvoke)) return finish(false, "call_not_invokable");
                stage = "start_call";
                dispatched = true;
                ((InvokePattern)callInvoke).Invoke();
                stage = "confirm_call";
                bool calling = Wait(() => CallActive() ? "calling" : null, 4500) != null;
                return finish(calling, calling ? "calling" : "call_uncertain");
            } catch (Failure e) { return finish(false, dispatched ? (action == "send" ? "send_uncertain" : "call_uncertain") : e.Code); }
            catch { return finish(false, dispatched ? (action == "send" ? "send_uncertain" : "call_uncertain") : "helper_error"); }
        }
    }
}
