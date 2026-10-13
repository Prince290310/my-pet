using System;
using System.Text;

namespace Shadow {
    // These predicates use measured accessibility bounds, not fixed screen locations.
    // Kept independent of Windows so the real selection rules can run in regression tests.
    public struct WhatsAppBounds {
        public double Left, Top, Width, Height;
        public double Right { get { return Left + Width; } }
        public double Bottom { get { return Top + Height; } }
        public WhatsAppBounds(double left, double top, double width, double height) {
            Left = left; Top = top; Width = width; Height = height;
        }
        public bool Valid {
            get { return Width > 0 && Height > 0 && !Double.IsNaN(Left + Top + Width + Height) && !Double.IsInfinity(Left + Top + Width + Height); }
        }
    }
    public static class WhatsAppLayout {
        public static bool SameName(string first, string second) {
            return String.Equals(CleanName(first), CleanName(second), StringComparison.OrdinalIgnoreCase);
        }
        static string CleanName(string value) {
            var clean = new StringBuilder();
            foreach (char c in value ?? "") {
                if (c == '\u200E' || c == '\u200F' || (c >= '\u202A' && c <= '\u202E') || (c >= '\u2066' && c <= '\u2069')) continue;
                clean.Append(c);
            }
            string text = clean.ToString().Trim();
            try { return text.Normalize(NormalizationForm.FormC); }
            catch (ArgumentException) { return text; } // An unrelated malformed provider label must not abort a search.
        }
        public static bool SidebarRow(WhatsAppBounds row, WhatsAppBounds label, WhatsAppBounds search, WhatsAppBounds window) {
            if (!row.Valid || !label.Valid || !search.Valid || !window.Valid) return false;
            double margin = search.Height * 2;
            return row.Left >= window.Left && row.Right <= search.Right + margin && row.Top >= search.Bottom &&
                row.Bottom <= window.Bottom && row.Height <= Math.Max(160, search.Height * 5) &&
                label.Left >= row.Left && label.Right <= row.Right && label.Top >= row.Top && label.Bottom <= row.Bottom;
        }
        public static bool Composer(WhatsAppBounds input, WhatsAppBounds search, WhatsAppBounds window,
            bool visible, bool focusable, bool readable, bool readOnly, bool password) {
            if (!input.Valid || !search.Valid || !window.Valid || !visible || !focusable || !readable || readOnly || password) return false;
            return input.Left >= search.Right && input.Right <= window.Right && input.Top >= window.Top + window.Height * 0.6 &&
                input.Bottom <= window.Bottom && input.Height <= Math.Max(search.Height * 5, window.Height * 0.25);
        }
    }
}
