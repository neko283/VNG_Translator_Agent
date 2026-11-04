import { AppError } from "../../../shared/error";

export function validate_zip_member_path(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[:<>"|?*\p{Cc}]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new AppError("file.invalid_structure", { public_details: { file: value } });
  return normalized;
}
