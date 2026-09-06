export function docsPath(id: string): string {
  return id === "wiki" ? "/wiki/" : `/wiki/${id.toLowerCase()}/`;
}

export function docsSectionLabel(id: string): string {
  const section = id.split("/")[0];

  switch (section) {
    case "guide":
      return "Certification Program Guide";
    case "prepare":
      return "How to Prepare";
    case "labs":
      return "Exam Labs";
    case "vouchers":
      return "Discounted Exam Vouchers";
    case "courses":
      return "Training Courses";
    case "azure":
    case "aibusiness":
    case "dynamics":
    case "github":
    case "microsoft365":
    case "power":
    case "security":
      return "Exam Study Materials";
    default:
      return "Microsoft Certification Wiki";
  }
}
