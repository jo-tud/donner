// Tiny glob matcher for folder include/exclude rules.
//   *  any characters except "/"
//   ** any characters including "/"
//   ?  one character
// Matching is case-insensitive.

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function matchesAny(value, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(value));
}
