using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Windows.Automation;
using System.Windows.Automation.Provider;

// An isolated fake chat window. Its buttons only write test events; there is no network or WhatsApp account.
public sealed class WhatsAppUiFixture : Form {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    readonly string log;
    readonly Label header;
    readonly FixtureBox editor;
    readonly FixtureRow result;
    readonly Timer watchdog;
    const string Contact = "Shadow fixture contact";
    readonly string linkFile;
    public WhatsAppUiFixture(string logPath, string mode, string linkPath = null) {
        log = logPath;
        linkFile = linkPath;
        Text = "WhatsApp - Shadow automation fixture";
        StartPosition = FormStartPosition.Manual;
        Location = new Point(100, 60);
        ClientSize = new Size(960, 580);
        // Somewhere for refused focus to go (like WebView-based WhatsApp keeping focus on its host).
        var sink = new Button { AccessibleName = "Fixture focus sink", Text = "", Location = new Point(4, 548), Size = new Size(14, 14) };
        Controls.Add(sink);
        string policy = mode == "click-focus" ? "click" : mode == "focus-never" ? "never" : "";
        Action<string> note = line => File.AppendAllText(log, line + "\n");
        var search = new FixtureBox { Name = "Search", AccessibleName = "Search", Location = new Point(24, 70), Size = new Size(260, 28), Policy = policy, Sink = sink, Log = note };
        search.KeyPress += (sender, args) => File.AppendAllText(log, "search-keypress\n");
        Controls.Add(search);
        if (mode.StartsWith("recycled-search", StringComparison.Ordinal)) search.TextChanged += (sender, args) => {
            if (search.Text != Contact) return;
            BeginInvoke(new Action(() => {
                if (search.IsDisposed) return;
                var fresh = new TextBox { Name = "Search", AccessibleName = "Search", Bounds = search.Bounds, Text = search.Text };
                fresh.KeyPress += (source, key) => File.AppendAllText(log, "search-keypress\n");
                Controls.Remove(search);
                search.Dispose();
                Controls.Add(fresh);
                fresh.Focus();
                File.AppendAllText(log, "search-recycled\n");
            }));
        };
        result = new FixtureRow { Name = "FixtureResult", Location = new Point(16, 115), Size = new Size(285, 72), BackColor = Color.LightGray };
        var label = new Label { AccessibleName = "\u202A" + Contact + "\u202C", Text = Contact, Location = new Point(12, 10), Size = new Size(248, 28) };
        result.Controls.Add(label);
        Controls.Add(result);
        var chatHeader = new Panel { Name = "ChatHeader", AccessibleName = "Contact info", Location = new Point(325, 12), Size = new Size(620, 50) };
        header = new Label { Name = "ContactName", AccessibleName = "Different chat", Text = "Different chat", Location = new Point(8, 12), Size = new Size(235, 26) };
        chatHeader.Controls.Add(header);
        Controls.Add(chatHeader);
        var voice = new Button { AccessibleName = "Voice call", Text = "Voice call", Location = new Point(268, 6), Size = new Size(150, 36) };
        var video = new Button { AccessibleName = "Video call", Text = "Video call", Location = new Point(435, 6), Size = new Size(150, 36) };
        chatHeader.Controls.Add(voice);
        chatHeader.Controls.Add(video);
        editor = new FixtureBox { Name = "FixtureEditor", AccessibleName = "Unlabelled fixture editor", Multiline = true,
            AcceptsReturn = true, Location = new Point(342, 492), Size = new Size(475, 64), Visible = false, Policy = mode == "click-focus" ? "click" : "", Sink = sink, Log = note };
        Controls.Add(editor);
        editor.KeyPress += (sender, args) => File.AppendAllText(log, "draft-keypress\n");
        var send = new Button { AccessibleName = "Send", Text = "Send", Location = new Point(832, 502), Size = new Size(100, 44), Visible = false };
        Controls.Add(send);
        EventHandler open = (sender, args) => {
            File.AppendAllText(log, "opened\n");
            if (mode != "wrong-header") { header.Text = Contact; header.AccessibleName = Contact; }
            editor.Visible = !mode.Contains("no-editor");
            send.Visible = editor.Visible;
        };
        result.Click += open;
        label.Click += open;
        // Like the real app, answer whatsapp://send?phone=...&text=... links (forwarded by a second
        // "--link" instance through a file): open that number's chat with the text typed in.
        if (mode.StartsWith("link", StringComparison.Ordinal) && linkFile != null) {
            var poll = new Timer { Interval = 100 };
            poll.Tick += (sender, args) => {
                if (!File.Exists(linkFile)) return;
                string url;
                try { url = File.ReadAllText(linkFile); File.Delete(linkFile); } catch (IOException) { return; }
                var query = url.Substring(url.IndexOf('?') + 1);
                string phone = "", text = "";
                foreach (var part in query.Split('&')) {
                    int eq = part.IndexOf('=');
                    if (eq < 0) continue;
                    string key = part.Substring(0, eq), value = Uri.UnescapeDataString(part.Substring(eq + 1));
                    if (key == "phone") phone = value;
                    if (key == "text") text = value;
                }
                File.AppendAllText(log, "link:" + phone + "\n");
                if (mode == "link-other") {
                    // A link that didn't take: some other chat is open with an empty message box.
                    header.Text = "Different chat"; header.AccessibleName = "Different chat";
                    editor.Visible = true; send.Visible = true; editor.Text = "";
                    return;
                }
                string shown = mode == "link-number" ? "+91 98765 43210" : Contact;
                header.Text = shown; header.AccessibleName = shown;
                editor.Visible = true; send.Visible = true;
                editor.Text = text;
                File.AppendAllText(log, "opened\n");
            };
            poll.Start();
        }
        EventHandler call = (sender, args) => {
            File.AppendAllText(log, sender == voice ? "voice\n" : "video\n");
            Controls.Add(new Button { AccessibleName = "End call", Text = "End call", Location = new Point(490, 210), Size = new Size(150, 40) });
        };
        voice.Click += call;
        video.Click += call;
        send.Click += (sender, args) => { File.AppendAllText(log, "sent:" + editor.Text.Replace("\r\n", "\n") + "\n"); editor.Clear(); };
        watchdog = new Timer { Interval = 45000 };
        watchdog.Tick += (sender, args) => Close();
        Shown += (sender, args) => { SetForegroundWindow(Handle); search.Focus(); watchdog.Start(); };
    }
    // Like a WebView field in the new WhatsApp: "click" ignores programmatic (UI Automation) focus and only
    // takes a real mouse click; "never" refuses focus altogether. Refused focus goes to the sink.
    sealed class FixtureBox : TextBox {
        public string Policy = "";
        public Control Sink;
        public Action<string> Log;
        bool clicked;
        protected override void WndProc(ref Message m) {
            if (m.Msg == 0x0201) { clicked = true; if (Policy != "" && Log != null) Log("click"); } // WM_LBUTTONDOWN (before the focus it causes)
            if (m.Msg == 0x0008) clicked = false; // WM_KILLFOCUS
            if (m.Msg == 0x0007 && Sink != null && (Policy == "never" || (Policy == "click" && !clicked))) { // WM_SETFOCUS
                if (Log != null) Log("focus-refused");
                Sink.Focus();
                return;
            }
            base.WndProc(ref m);
        }
    }
    // Model a WebView custom result with an exact name and clickable point, but no Invoke/Selection pattern.
    sealed class FixtureRow : Panel, IRawElementProviderSimple {
        public ProviderOptions ProviderOptions { get { return System.Windows.Automation.Provider.ProviderOptions.ServerSideProvider; } }
        public IRawElementProviderSimple HostRawElementProvider { get { return AutomationInteropProvider.HostProviderFromHandle(Handle); } }
        public object GetPatternProvider(int patternId) { return null; }
        public object GetPropertyValue(int id) {
            if (id == AutomationElement.NameProperty.Id) return "\u202A" + Contact + "\u202C";
            if (id == AutomationElement.ControlTypeProperty.Id) return ControlType.Custom.Id;
            if (id == AutomationElement.IsEnabledProperty.Id || id == AutomationElement.IsControlElementProperty.Id || id == AutomationElement.IsContentElementProperty.Id) return true;
            if (id == AutomationElement.IsKeyboardFocusableProperty.Id || id == AutomationElement.IsOffscreenProperty.Id) return false;
            var bounds = RectangleToScreen(ClientRectangle);
            if (id == AutomationElement.BoundingRectangleProperty.Id) return new double[] { bounds.Left, bounds.Top, bounds.Width, bounds.Height };
            if (id == AutomationElement.ClickablePointProperty.Id) return new double[] { bounds.Left + bounds.Width / 2.0, bounds.Top + bounds.Height / 2.0 };
            return null;
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x003D && message.LParam.ToInt64() == AutomationInteropProvider.RootObjectId) {
                message.Result = AutomationInteropProvider.ReturnRawElementProvider(Handle, message.WParam, message.LParam, this);
                return;
            }
            base.WndProc(ref message);
        }
    }
    [STAThread] public static void Main(string[] args) {
        // Started by Windows for a whatsapp: link (see test-whatsapp-ui.ps1): hand the link to the open fixture.
        if (args.Length >= 3 && args[0] == "--link") {
            File.WriteAllText(args[1], args[2]);
            return;
        }
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.Run(new WhatsAppUiFixture(args[0], args[1], args.Length > 2 ? args[2] : null));
    }
}
