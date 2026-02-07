-- Enable Row Level Security on users table
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own data
CREATE POLICY "Users can view own data"
    ON public.users
    FOR SELECT
    USING (auth.uid() = firebase_uid);

-- Policy: Users can update their own data
CREATE POLICY "Users can update own data"
    ON public.users
    FOR UPDATE
    USING (auth.uid() = firebase_uid)
    WITH CHECK (auth.uid() = firebase_uid);

-- Policy: Service role can do everything (bypass RLS)
CREATE POLICY "Service role has full access"
    ON public.users
    FOR ALL
    USING (auth.role() = 'service_role');

-- Policy: Allow insert for authenticated users (for initial sync)
CREATE POLICY "Allow insert for authenticated users"
    ON public.users
    FOR INSERT
    WITH CHECK (auth.uid() = firebase_uid);

-- Add comments to policies
COMMENT ON POLICY "Users can view own data" ON public.users IS 'Allows users to read only their own data based on firebase_uid from JWT token';
COMMENT ON POLICY "Users can update own data" ON public.users IS 'Allows users to update only their own data based on firebase_uid from JWT token';
COMMENT ON POLICY "Service role has full access" ON public.users IS 'Allows service role to bypass RLS for administrative operations';
COMMENT ON POLICY "Allow insert for authenticated users" ON public.users IS 'Allows authenticated users to insert their own data during initial sync';
