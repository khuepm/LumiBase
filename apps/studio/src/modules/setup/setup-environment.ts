type SetupRuntimeEnv = Pick<ImportMetaEnv, 'PROD' | 'VITE_LUMIBASE_RELEASE_CHANNEL'>;

export function shouldAutoRedirectToAdmin(env: SetupRuntimeEnv = import.meta.env): boolean {
  const releaseChannel = env.VITE_LUMIBASE_RELEASE_CHANNEL?.trim().toLowerCase();

  return env.PROD !== true && releaseChannel !== 'production';
}
