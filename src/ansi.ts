const ANSI_RE = /\x1b\[[0-9;]*m/g;

function supportsColor(): boolean {
  const env = process.env;
  if (env.NO_COLOR && env.NO_COLOR !== "") return false;
  if ("NO_COLOR" in env) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR) return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout?.isTTY);
}

function wrap(open: string, close: string): (text: string) => string {
  return (text: string) => {
    if (!supportsColor() || text === "") return text;
    return `${open}${text}${close}`;
  };
}

export const bold = wrap("\x1b[1m", "\x1b[22m");
export const dim = wrap("\x1b[2m", "\x1b[22m");
export const red = wrap("\x1b[31m", "\x1b[39m");
export const green = wrap("\x1b[32m", "\x1b[39m");
export const yellow = wrap("\x1b[33m", "\x1b[39m");
export const cyan = wrap("\x1b[36m", "\x1b[39m");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
