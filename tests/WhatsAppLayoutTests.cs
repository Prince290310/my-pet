using System;
using Shadow;

// Runs the production layout/name predicates without UI Automation or a real WhatsApp account.
public static class WhatsAppLayoutTests {
    static int passed;
    static void Check(string name, bool ok) {
        if (!ok) throw new Exception(name);
        passed++;
        Console.WriteLine("PASS: " + name);
    }
    public static void Main() {
        var window = new WhatsAppBounds(100, 50, 1000, 700);
        var search = new WhatsAppBounds(130, 120, 270, 32);
        var label = new WhatsAppBounds(160, 184, 150, 24);
        Check("custom sidebar row contains the exact contact label", WhatsAppLayout.SidebarRow(new WhatsAppBounds(125, 160, 310, 68), label, search, window));
        Check("search input cannot be a result row", !WhatsAppLayout.SidebarRow(search, label, search, window));
        Check("whole results list is not an individual row", !WhatsAppLayout.SidebarRow(new WhatsAppBounds(120, 160, 315, 500), label, search, window));
        Check("contact header in the message pane is not a sidebar result", !WhatsAppLayout.SidebarRow(new WhatsAppBounds(470, 100, 240, 60), new WhatsAppBounds(490, 110, 150, 24), search, window));
        Check("ancestor must actually contain the matching label", !WhatsAppLayout.SidebarRow(new WhatsAppBounds(125, 230, 310, 68), label, search, window));
        Check("empty result bounds are rejected", !WhatsAppLayout.SidebarRow(new WhatsAppBounds(125, 160, 0, 68), label, search, window));
        var editor = new WhatsAppBounds(490, 650, 510, 52);
        Check("unnamed bottom editor is accepted when readable and focusable", WhatsAppLayout.Composer(editor, search, window, true, true, true, false, false));
        Check("sidebar search cannot be mistaken for the message editor", !WhatsAppLayout.Composer(search, search, window, true, true, true, false, false));
        Check("chat history document is not the editor", !WhatsAppLayout.Composer(new WhatsAppBounds(440, 160, 630, 480), search, window, true, true, true, false, false));
        Check("top toolbar input is not the editor", !WhatsAppLayout.Composer(new WhatsAppBounds(490, 120, 510, 36), search, window, true, true, true, false, false));
        Check("offscreen editor is rejected", !WhatsAppLayout.Composer(editor, search, window, false, true, true, false, false));
        Check("nonfocusable editor is rejected", !WhatsAppLayout.Composer(editor, search, window, true, false, true, false, false));
        Check("unreadable editor is rejected", !WhatsAppLayout.Composer(editor, search, window, true, true, false, false, false));
        Check("read-only editor is rejected", !WhatsAppLayout.Composer(editor, search, window, true, true, true, true, false));
        Check("password input is rejected", !WhatsAppLayout.Composer(editor, search, window, true, true, true, false, true));
        Check("input outside the window is rejected", !WhatsAppLayout.Composer(new WhatsAppBounds(490, 740, 510, 52), search, window, true, true, true, false, false));
        Check("large bottom document cannot substitute for an editor", !WhatsAppLayout.Composer(new WhatsAppBounds(490, 470, 510, 250), search, window, true, true, true, false, false));
        Check("layout works on a monitor with negative coordinates", WhatsAppLayout.Composer(new WhatsAppBounds(-600, 700, 500, 40), new WhatsAppBounds(-1200, 100, 260, 32), new WhatsAppBounds(-1280, 0, 1280, 800), true, true, true, false, false));
        Check("NaN coordinates are rejected", !WhatsAppLayout.Composer(new WhatsAppBounds(Double.NaN, 650, 510, 52), search, window, true, true, true, false, false));
        Check("directional wrappers around contact names are ignored", WhatsAppLayout.SameName("Mom", "\u202AMom\u202C"));
        Check("Unicode normalization and casing preserve contact identity", WhatsAppLayout.SameName("Jos\u00E9", " JOSE\u0301 "));
        Check("distinct contacts stay distinct", !WhatsAppLayout.SameName("Mom", "Mom work"));
        Check("meaningful zero width joiners are preserved", !WhatsAppLayout.SameName("A\u200DB", "AB"));
        Console.WriteLine(passed + " production selector regression checks passed");
    }
}
