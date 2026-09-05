export const documentCommands = new Map<
  string,
  { save: () => Promise<boolean>; dirty: boolean }
>();
