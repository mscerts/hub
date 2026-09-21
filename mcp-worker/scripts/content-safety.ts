const RESERVED_DELIMITERS = [
  "<msfthub_untrusted_content>",
  "</msfthub_untrusted_content>",
];

const INSTRUCTION_PATTERNS = [
  {
    name: "instruction override",
    pattern:
      /\b(?:ignore|disregard|override)\b[\s\S]{0,40}\b(?:previous|prior|above|system|developer)\b[\s\S]{0,20}\binstructions?\b/i,
  },
  {
    name: "privileged prompt reference",
    pattern: /\b(?:system|developer)\s+(?:prompt|message)\b/i,
  },
  {
    name: "model role assignment",
    pattern: /\byou are (?:chatgpt|an? (?:ai|language model|assistant))\b/i,
  },
  {
    name: "model control token",
    pattern: /<\|(?:im_start|im_end|system|assistant|developer)\|>/i,
  },
];

export function findInstructionLikeContent(content: string): string[] {
  const findings = INSTRUCTION_PATTERNS.filter(({ pattern }) =>
    pattern.test(content),
  ).map(({ name }) => name);

  if (RESERVED_DELIMITERS.some((delimiter) => content.includes(delimiter))) {
    findings.push("reserved trust-boundary delimiter");
  }

  return findings;
}

export function assertSafeBundledContent(
  content: string,
  source: string,
): void {
  const findings = findInstructionLikeContent(content);
  if (findings.length > 0) {
    throw new Error(
      `Instruction-like content detected in ${source}: ${findings.join(", ")}`,
    );
  }
}
