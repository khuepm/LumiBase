type SetupRuntimeEnv = Pick<
  ImportMetaEnv,
  'PROD' | 'VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT' | 'VITE_LUMIBASE_RELEASE_CHANNEL'
>;

export function shouldAutoRedirectToAdmin(env: SetupRuntimeEnv = import.meta.env): boolean {
  const releaseChannel = env.VITE_LUMIBASE_RELEASE_CHANNEL?.trim().toLowerCase();
  const allowRedirectOverride =
    env.VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT?.trim().toLowerCase() === 'true';

  return allowRedirectOverride || (env.PROD !== true && releaseChannel !== 'production');
}
