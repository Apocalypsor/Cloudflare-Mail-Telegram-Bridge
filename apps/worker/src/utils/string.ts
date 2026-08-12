export const utf8Decoder = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: false,
});

export const escapeBackslashAndDoubleQuote = (value: string): string => {
  let escaped = "";
  for (const char of value) {
    escaped += char === "\\" || char === '"' ? `\\${char}` : char;
  }
  return escaped;
};

export const escapeBackslashAndBacktick = (value: string): string => {
  let escaped = "";
  for (const char of value) {
    escaped += char === "\\" || char === "`" ? `\\${char}` : char;
  }
  return escaped;
};

export const escapeHtmlText = (value: string): string => {
  let escaped = "";
  for (const char of value) {
    if (char === "&") escaped += "&amp;";
    else if (char === "<") escaped += "&lt;";
    else if (char === ">") escaped += "&gt;";
    else escaped += char;
  }
  return escaped;
};

export const stripHtmlTags = (input: string): string => {
  let output = "";
  let inTag = false;
  for (const char of input) {
    if (inTag) {
      if (char === ">") inTag = false;
      continue;
    }
    if (char === "<") {
      inTag = true;
      continue;
    }
    output += char;
  }
  return output;
};

export const truncateUnicodeText = (
  value: string,
  maxCharacters: number,
): string => {
  const characters = [...value];
  if (characters.length <= maxCharacters) return value;
  if (maxCharacters <= 1) return characters.slice(0, maxCharacters).join("");
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
};

export const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
};
