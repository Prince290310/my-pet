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
    readonly TextBox editor;
    readonly FixtureRow result;
    readonly Timer watchdog;
    const string Contact = "Shadow fixture contact";
    public WhatsAppUiFixture(string logPath, string mode) {
        log = logPath;
        Text = "WhatsApp - Shadow automation fixture";
        StartPosition = FormStartPosition.Manual;
        Location = new Point(100, 60);
        ClientSize = new Size(960, 580);
        var search = new TextBox { Name = "Search", AccessibleName = "Search", Location = new Point(24, 70), Size = new Size(260, 28) };
        search.KeyPress += (sender, args) => File.AppendAllText(log, "search-keypress\n");
        Controls.Add(search);
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
        editor = new TextBox { Name = "FixtureEditor", AccessibleName = "Unlabelled fixture editor", Multiline = true,
            AcceptsReturn = true, Location = new Point(342, 492), Size = new Size(475, 64), Visible = false };
        Controls.Add(editor);
        editor.KeyPress += (sender, args) => File.AppendAllText(log, "draft-keypress\n");
        var send = new Button { AccessibleName = "Send", Text = "Send", Location = new Point(832, 502), Size = new Size(100, 44), Visible = false };
        Controls.Add(send);
        EventHandler open = (sender, args) => {
            File.AppendAllText(log, "opened\n");
            if (mode != "wrong-header") { header.Text = Contact; header.AccessibleName = Contact; }
            editor.Visible = mode != "no-editor";
            send.Visible = editor.Visible;
        };
        result.Click += open;
        label.Click += open;
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
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.Run(new WhatsAppUiFixture(args[0], args[1]));
    }
}
