import { useRadar } from "../store";

export function ThemeToggle({ className = "" }: { className?: string }): JSX.Element {
  const theme = useRadar((s) => s.theme);
  const toggleTheme = useRadar((s) => s.toggleTheme);
  const dark = theme === "dark";
  return (
    <button
      className={`theme-toggle ${className}`}
      onClick={toggleTheme}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? "☀" : "☾"}
    </button>
  );
}
