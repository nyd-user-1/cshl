import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  // "nsrgpt-theme" is the NSR-era key; keep reading it so an existing visitor's
  // choice survives the rename, but write only the new key.
  return ((localStorage.getItem("app-theme") ?? localStorage.getItem("nsrgpt-theme")) as Theme) ?? "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("app-theme", t);
  };

  const toggle = () => setTheme(theme === "light" ? "dark" : "light");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
