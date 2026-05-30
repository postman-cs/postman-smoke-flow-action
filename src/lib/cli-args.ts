export function applyArgsToEnv(argv: string[], env: NodeJS.ProcessEnv): void {
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      continue;
    }

    const rawInput = key.slice(2);
    const equalsIndex = rawInput.indexOf('=');
    const inputName = equalsIndex >= 0 ? rawInput.slice(0, equalsIndex) : rawInput;
    const value = equalsIndex >= 0 ? rawInput.slice(equalsIndex + 1) : argv[index + 1];
    env[`INPUT_${inputName.replace(/-/g, '_').toUpperCase()}`] = value ?? '';

    if (equalsIndex < 0) {
      index += 1;
    }
  }
}
