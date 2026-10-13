using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

namespace Shadow {
    public sealed class WhatsAppResult {
        public bool ok { get; set; }
        public string code { get; set; }
    }
    // All selectors refer to WhatsApp's own accessibility tree. No screen-coordinate clicks.
    public static class WhatsAppDesktop {
        static readonly string[] SearchNames = { "Search", "Search or start new chat", "Search chats", "Search or start a new chat" };
        static readonly string[] ComposeNames = { "Type a message", "Message", "Enter a message", "Message input" };
        static readonly string[] VoiceNames = { "Voice call", "Audio call", "Start voice call", "Start audio call" };
        static readonly string[] VideoNames = { "Video call", "Start video call" };
        static readonly string[] EndNames = { "End call", "Hang up", "Cancel call" };
        static readonly string[] SendNames = { "Send", "Send message" };
        static readonly string[] InfoNames = { "Contact info", "Chat info", "Open contact info", "View contact info", "Open chat info" };
        sealed class Failure : Exception {
            public readonly string Code;
            public Failure(string code) { Code = code; }
        }
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
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
            foreach (AutomationElement e in Elements(root))
                if (e.Current.ControlType == type && Usable(e) && HasName(e, names)) return e;
            return null;
        }
        static bool WhatsAppProcess(int id) {
            try {
                string name = Process.GetProcessById(id).ProcessName;
                return Same(name, "WhatsApp") || Same(name, "WhatsAppBeta");
            } catch { return false; }
        }
        static bool WhatsAppWindow(AutomationElement root) {
            if (WhatsAppProcess(root.Current.ProcessId)) return true;
            try {
                if (!Same(Process.GetProcessById(root.Current.ProcessId).ProcessName, "ApplicationFrameHost")) return false;
                foreach (AutomationElement e in Elements(root)) if (WhatsAppProcess(e.Current.ProcessId)) return true;
            } catch { }
            return false;
        }
        static AutomationElement Window() {
            var roots = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
            var found = new List<AutomationElement>();
            foreach (AutomationElement root in roots) {
                string name = root.Current.Name.Trim();
                if ((Same(name, "WhatsApp") || Same(name, "WhatsApp Beta")) && WhatsAppWindow(root)) found.Add(root);
            }
            if (found.Count > 1) throw new Failure("multiple_windows");
            return found.Count == 1 ? found[0] : null;
        }
        static bool CallActive() {
            var roots = AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
            foreach (AutomationElement root in roots) if (WhatsAppWindow(root) && Find(root, ControlType.Button, EndNames) != null) return true;
            return false;
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
        static void AssertWindow(AutomationElement root) {
            var handle = new IntPtr(root.Current.NativeWindowHandle);
            if (!IsWindow(handle) || !WhatsAppWindow(root)) throw new Failure("unavailable");
            if (GetForegroundWindow() != handle) throw new Failure("focus_changed");
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
        static void Focus(AutomationElement root, AutomationElement target) {
            AssertWindow(root);
            target.SetFocus();
            Thread.Sleep(60);
            if (!Automation.Compare(target, AutomationElement.FocusedElement)) throw new Failure("focus_changed");
        }
        static Input Key(ushort code, bool up, bool unicode) {
            var value = new Input { type = 1 };
            value.data.keyboard = new KeyInput { key = unicode ? (ushort)0 : code, scan = unicode ? code : (ushort)0, flags = (unicode ? 4u : 0u) | (up ? 2u : 0u) };
            return value;
        }
        static void SendKeys(AutomationElement root, AutomationElement edit, Input[] inputs) {
            AssertWindow(root);
            if (!Automation.Compare(edit, AutomationElement.FocusedElement)) throw new Failure("focus_changed");
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length) throw new Failure("controls_unavailable");
        }
        static void Write(AutomationElement root, AutomationElement edit, string text) {
            AssertWindow(root);
            object raw;
            if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out raw) && !((ValuePattern)raw).Current.IsReadOnly) {
                ((ValuePattern)raw).SetValue(text);
                return;
            }
            Focus(root, edit);
            SendKeys(root, edit, new[] { Key(0x11, false, false), Key(0x41, false, false), Key(0x41, true, false), Key(0x11, true, false) });
            // Literal Unicode input; braces, quotes and shell metacharacters are never shortcuts.
            foreach (char ch in text.Replace("\r\n", "\n")) {
                if (ch == '\n') SendKeys(root, edit, new[] { Key(0x10, false, false), Key(0x0D, false, false), Key(0x0D, true, false), Key(0x10, true, false) });
                else SendKeys(root, edit, new[] { Key(ch, false, true), Key(ch, true, true) });
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
        static void Activate(AutomationElement root, AutomationElement element) {
            AssertWindow(root);
            object raw;
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out raw)) ((InvokePattern)raw).Invoke();
            else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out raw)) ((SelectionItemPattern)raw).Select();
            else {
                Focus(root, element);
                SendKeys(root, element, new[] { Key(0x0D, false, false), Key(0x0D, true, false) });
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
        static bool HeaderMatches(AutomationElement root, string contact, double sidebarRight, double headerBottom, AutomationElement compose) {
            var input = compose.Current.BoundingRectangle;
            foreach (AutomationElement e in Elements(root)) {
                if (!Usable(e) || !Same(e.Current.Name, contact) || !HeaderControl(e, root)) continue;
                var rect = e.Current.BoundingRectangle;
                // Verify the chat header in the message pane, never a matching message or sidebar row.
                if (rect.Left >= sidebarRight && rect.Bottom <= headerBottom && rect.Bottom < input.Top && rect.Left >= input.Left - 90) return true;
            }
            return false;
        }
        static void AssertRecipient(AutomationElement root, string contact, double right, double headerBottom, AutomationElement compose) {
            AssertWindow(root);
            if (ModalOpen(root)) throw new Failure("dialog_open");
            if (!HeaderMatches(root, contact, right, headerBottom, compose)) throw new Failure("recipient_unverified");
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
            try {
                if (action != "status" && action != "send" && action != "call") return Result(false, "helper_error");
                if (action != "status" && !ValidContact(contact)) return Result(false, "helper_error");
                if (action == "send" && !ValidMessage(message)) return Result(false, "helper_error");
                if (action == "call" && callType != "voice" && callType != "video") return Result(false, "helper_error");
                var root = Wait(() => Window(), waitForApp ? 6000 : 100);
                if (root == null) return Result(false, "not_running");
                if (action != "status") {
                    var handle = new IntPtr(root.Current.NativeWindowHandle);
                    ShowWindow(handle, 9);
                    SetForegroundWindow(handle);
                    Thread.Sleep(200);
                    AssertWindow(root);
                }
                var search = Wait(() => Find(root, ControlType.Edit, SearchNames), waitForApp ? 4000 : 1200);
                if (search == null) return Result(false, "controls_unavailable");
                if (action == "status") return Result(true, "ready");
                if (ModalOpen(root)) return Result(false, "dialog_open");
                if (CallActive()) return Result(false, "call_active");
                double sidebarRight = search.Current.BoundingRectangle.Right;
                double headerBottom = search.Current.BoundingRectangle.Bottom + 24;
                Write(root, search, contact);
                // Wait for filtering to settle before accepting an exact, unique result.
                Thread.Sleep(800);
                List<AutomationElement> matches = null;
                Wait(() => { matches = Matches(root, search, contact); return matches.Count > 0 ? matches : null; }, 3500);
                if (matches == null || matches.Count == 0) return Result(false, "not_found");
                Thread.Sleep(250);
                matches = Matches(root, search, contact);
                if (matches.Count != 1) return Result(false, matches.Count > 1 ? "ambiguous" : "not_found");
                Activate(root, matches[0]);
                var compose = Wait(() => Find(root, ControlType.Edit, ComposeNames), 3500);
                if (compose == null) return Result(false, "controls_unavailable");
                AssertRecipient(root, contact, sidebarRight, headerBottom, compose);
                if (action == "send") {
                    string expected = message.Replace("\r\n", "\n");
                    string draft = Read(compose);
                    if (draft.Length > 0 && draft != expected) return Result(false, "draft_exists");
                    Write(root, compose, expected);
                    Thread.Sleep(150);
                    if (Read(compose) != expected) return Result(false, "message_unverified");
                    AssertRecipient(root, contact, sidebarRight, headerBottom, compose);
                    var send = Find(root, ControlType.Button, SendNames);
                    if (send == null) return Result(false, "send_unavailable");
                    // Sending and calling require an actual InvokePattern, never a guessed Enter key.
                    object invoke;
                    if (!send.TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) return Result(false, "send_unavailable");
                    if (Read(compose) != expected) return Result(false, "message_unverified");
                    AssertRecipient(root, contact, sidebarRight, headerBottom, compose);
                    dispatched = true;
                    ((InvokePattern)invoke).Invoke();
                    bool cleared = Wait(() => Read(compose).Length == 0 ? "cleared" : null, 3000) != null;
                    return Result(cleared, cleared ? "sent" : "send_uncertain");
                }
                var call = Find(root, ControlType.Button, callType == "voice" ? VoiceNames : VideoNames);
                if (call == null) return Result(false, "call_unavailable");
                AssertRecipient(root, contact, sidebarRight, headerBottom, compose);
                if (CallActive()) return Result(false, "call_active");
                object callInvoke;
                if (!call.TryGetCurrentPattern(InvokePattern.Pattern, out callInvoke)) return Result(false, "call_unavailable");
                dispatched = true;
                ((InvokePattern)callInvoke).Invoke();
                bool calling = Wait(() => CallActive() ? "calling" : null, 4500) != null;
                return Result(calling, calling ? "calling" : "call_uncertain");
            } catch (Failure e) { return Result(false, dispatched ? (action == "send" ? "send_uncertain" : "call_uncertain") : e.Code); }
            catch { return Result(false, dispatched ? (action == "send" ? "send_uncertain" : "call_uncertain") : "helper_error"); }
        }
    }
}
