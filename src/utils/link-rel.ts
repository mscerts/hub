export function linkRel(target?: string | null, rel?: string | null) {
  if (target?.toLowerCase() !== "_blank") return rel;

  const tokens = new Set(
    (rel ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.toLowerCase()),
  );
  tokens.delete("opener");
  tokens.add("noopener");
  tokens.add("noreferrer");
  return [...tokens].join(" ");
}
