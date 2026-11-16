const notes = new Map([
  [
    "AB-730",
    "Microsoft 365 Copilot has been renamed Microsoft Copilot. During the transition, some exam questions may still use Microsoft 365 Copilot for the product; interpret it as Microsoft Copilot unless the question is specifically about licensing. Microsoft 365 Copilot remains the license name.",
  ],
  [
    "AB-731",
    "Microsoft 365 Copilot has been renamed Microsoft Copilot. During the transition, some exam questions may still use Microsoft 365 Copilot for the product; interpret it as Microsoft Copilot unless the question is specifically about licensing. Microsoft 365 Copilot remains the license name.",
  ],
]);

export const guideChangeNoteFor = (code) => notes.get(code) ?? null;
