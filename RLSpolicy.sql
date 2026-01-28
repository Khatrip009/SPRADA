-- rls_migration.sql
-- Migration: create app/admin roles, enable RLS and install example policies
-- Target DB: exotech_sprada (Postgres 17), run as superuser (postgres)
-- Port: 5435 (adjust your psql connection command accordingly)

-- ---------------------------
-- 0. Safety / info comments
-- ---------------------------
-- This script creates two roles:
--  - exotech_app   : the application role used by your backend (NO BYPASSRLS). CHANGE THE PASSWORD.
--  - sprada_admin  : the admin role you specified; will be granted BYPASSRLS to allow trusted ops.
--
-- Policies use session settings:
--   SET LOCAL app.user_id = '<uuid>';
--   SET LOCAL app.user_role = '<role_name>';
-- Your backend must set these inside the same transaction where it issues queries so RLS policies can refer to them.
--
-- If you use PgBouncer, use transaction pooling mode so SET LOCAL is transaction-scoped and cannot leak.
--
-- NOTE: After running, test thoroughly. To inspect policies:
--   \d+ products
--   SELECT * FROM pg_policy WHERE polrelid = 'products'::regclass;

-- ---------------------------
-- 1. Create roles
-- ---------------------------

-- Create application role (no BYPASSRLS, NOINHERIT)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'exotech_app') THEN
    CREATE ROLE exotech_app LOGIN PASSWORD 'change_this_app_password' NOINHERIT;
  END IF;
END$$;

-- Create admin role with the username & password you provided (sprada_admin)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sprada_admin') THEN
    CREATE ROLE sprada_admin LOGIN PASSWORD 'exotech@admin123' NOINHERIT;
  END IF;
END$$;

-- Grant BYPASSRLS to admin role (sprada_admin)
-- Note: only superuser can grant BYPASSRLS
ALTER ROLE sprada_admin BYPASSRLS;

-- ---------------------------
-- 2. Grant minimal privileges to exotech_app
-- ---------------------------

GRANT CONNECT ON DATABASE exotech_sprada TO exotech_app;
GRANT USAGE ON SCHEMA public TO exotech_app;

-- Grant basic DML privileges on all existing tables (adapt later for least-privilege)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO exotech_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO exotech_app;

-- If new tables are created later, consider granting privileges via migrations or explicit grants.

-- ---------------------------
-- 3. Enable RLS on selected tables
-- ---------------------------
-- Add tables here that should be protected by policies.
-- If a table does not exist, ALTER TABLE will fail; we guard with DO blocks.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'products') THEN
    EXECUTE 'ALTER TABLE products ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'blogs') THEN
    EXECUTE 'ALTER TABLE blogs ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'customers') THEN
    EXECUTE 'ALTER TABLE customers ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'reviews') THEN
    EXECUTE 'ALTER TABLE reviews ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'product_images') THEN
    EXECUTE 'ALTER TABLE product_images ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'analytics_events') THEN
    EXECUTE 'ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'push_subscriptions') THEN
    EXECUTE 'ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'notifications') THEN
    EXECUTE 'ALTER TABLE notifications ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'notification_logs') THEN
    EXECUTE 'ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'cookie_consents') THEN
    EXECUTE 'ALTER TABLE cookie_consents ENABLE ROW LEVEL SECURITY';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'visitors') THEN
    EXECUTE 'ALTER TABLE visitors ENABLE ROW LEVEL SECURITY';
  END IF;
END$$;

-- ---------------------------
-- 4. Install example RLS policies
-- ---------------------------
-- Policies refer to session setting 'app.user_id' which your backend will set (SET LOCAL app.user_id = 'uuid').

-- Helper: if the policy already exists, drop it first to allow rerun of this script safely.
-- Note: dropping non-existent policy will error, so we use DO blocks to conditionally drop.

-- PRODUCTS policies
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'products_select_policy' AND polrelid = 'products'::regclass) THEN
    EXECUTE 'DROP POLICY products_select_policy ON products';
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'products') THEN
    EXECUTE $sql$
      CREATE POLICY products_select_policy ON products
        FOR SELECT
        USING (
          is_published
          OR (
            current_setting('app.user_id', true) IS NOT NULL
            AND created_by = current_setting('app.user_id', true)::uuid
          )
          OR (
            current_setting('app.user_id', true) IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id = 1
            )
          )
        );
    $sql$;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'products') THEN
    -- insert policy: only editors/admins (role_id IN (1,2)) can insert
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'products_insert_policy' AND polrelid = 'products'::regclass) THEN
      EXECUTE 'DROP POLICY products_insert_policy ON products';
    END IF;

    EXECUTE $sql$
      CREATE POLICY products_insert_policy ON products
        FOR INSERT
        WITH CHECK (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
          )
        );
    $sql$;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'products') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'products_update_policy' AND polrelid = 'products'::regclass) THEN
      EXECUTE 'DROP POLICY products_update_policy ON products';
    END IF;

    EXECUTE $sql$
      CREATE POLICY products_update_policy ON products
        FOR UPDATE
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND (
            created_by = current_setting('app.user_id', true)::uuid
            OR EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
            )
          )
        )
        WITH CHECK (
          current_setting('app.user_id', true) IS NOT NULL
          AND (
            created_by = current_setting('app.user_id', true)::uuid
            OR EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
            )
          )
        );
    $sql$;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'products') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'products_delete_policy' AND polrelid = 'products'::regclass) THEN
      EXECUTE 'DROP POLICY products_delete_policy ON products';
    END IF;

    EXECUTE $sql$
      CREATE POLICY products_delete_policy ON products
        FOR DELETE
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id = 1
          )
        );
    $sql$;
  END IF;
END$$;

-- BLOGS policies
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'blogs') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'blogs_select_policy' AND polrelid = 'blogs'::regclass) THEN
      EXECUTE 'DROP POLICY blogs_select_policy ON blogs';
    END IF;

    EXECUTE $sql$
      CREATE POLICY blogs_select_policy ON blogs
        FOR SELECT
        USING (
          is_published
          OR (
            current_setting('app.user_id', true) IS NOT NULL
            AND author_id = current_setting('app.user_id', true)::uuid
          )
          OR (
            current_setting('app.user_id', true) IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
            )
          )
        );
    $sql$;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'blogs') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'blogs_insert_policy' AND polrelid = 'blogs'::regclass) THEN
      EXECUTE 'DROP POLICY blogs_insert_policy ON blogs';
    END IF;

    EXECUTE $sql$
      CREATE POLICY blogs_insert_policy ON blogs
        FOR INSERT
        WITH CHECK (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
          )
        );
    $sql$;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'blogs') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'blogs_update_policy' AND polrelid = 'blogs'::regclass) THEN
      EXECUTE 'DROP POLICY blogs_update_policy ON blogs';
    END IF;

    EXECUTE $sql$
      CREATE POLICY blogs_update_policy ON blogs
        FOR UPDATE
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND (
            author_id = current_setting('app.user_id', true)::uuid
            OR EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
            )
          )
        )
        WITH CHECK (
          current_setting('app.user_id', true) IS NOT NULL
          AND (
            author_id = current_setting('app.user_id', true)::uuid
            OR EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
            )
          )
        );
    $sql$;
  END IF;
END$$;

-- CUSTOMERS policies (allow public inserts, restrict selects to admin/editor)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'customers') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'customers_select_policy' AND polrelid = 'customers'::regclass) THEN
      EXECUTE 'DROP POLICY customers_select_policy ON customers';
    END IF;

    EXECUTE $sql$
      CREATE POLICY customers_select_policy ON customers
        FOR SELECT
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
          )
        );
    $sql$;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'customers_insert_policy' AND polrelid = 'customers'::regclass) THEN
      EXECUTE 'DROP POLICY customers_insert_policy ON customers';
    END IF;

    -- allow public inserts (contact form), but you should sanitize & rate limit in the app
    EXECUTE $sql$
      CREATE POLICY customers_insert_policy ON customers
        FOR INSERT
        WITH CHECK (true);
    $sql$;
  END IF;
END$$;

-- REVIEWS policies
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'reviews') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'reviews_select_policy' AND polrelid = 'reviews'::regclass) THEN
      EXECUTE 'DROP POLICY reviews_select_policy ON reviews';
    END IF;

    EXECUTE $sql$
      CREATE POLICY reviews_select_policy ON reviews
        FOR SELECT
        USING (
          is_published
          OR (
            current_setting('app.user_id', true) IS NOT NULL
            AND author_id = current_setting('app.user_id', true)::uuid
          )
          OR (
            current_setting('app.user_id', true) IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2)
            )
          )
        );
    $sql$;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'reviews_insert_policy' AND polrelid = 'reviews'::regclass) THEN
      EXECUTE 'DROP POLICY reviews_insert_policy ON reviews';
    END IF;

    -- allow public inserts; moderation controls publish flag
    EXECUTE $sql$
      CREATE POLICY reviews_insert_policy ON reviews
        FOR INSERT
        WITH CHECK (true);
    $sql$;
  END IF;
END$$;

-- ANALYTICS policies
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'analytics_events') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'analytics_insert_policy' AND polrelid = 'analytics_events'::regclass) THEN
      EXECUTE 'DROP POLICY analytics_insert_policy ON analytics_events';
    END IF;

    EXECUTE $sql$
      CREATE POLICY analytics_insert_policy ON analytics_events
        FOR INSERT
        WITH CHECK (
          -- allow insert only when app.user_id is set (backend identifies source)
          current_setting('app.user_id', true) IS NOT NULL
        );
    $sql$;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'analytics_select_policy' AND polrelid = 'analytics_events'::regclass) THEN
      EXECUTE 'DROP POLICY analytics_select_policy ON analytics_events';
    END IF;

    EXECUTE $sql$
      CREATE POLICY analytics_select_policy ON analytics_events
        FOR SELECT
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id = 1
          )
        );
    $sql$;
  END IF;
END$$;

-- Additional: restrict push_subscriptions/select to owner or admin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'push_subscriptions') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'pushsubs_select_policy' AND polrelid = 'push_subscriptions'::regclass) THEN
      EXECUTE 'DROP POLICY pushsubs_select_policy ON push_subscriptions';
    END IF;

    EXECUTE $sql$
      CREATE POLICY pushsubs_select_policy ON push_subscriptions
        FOR SELECT
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND (
            visitor_id::text = current_setting('app.user_id', true)
            OR EXISTS (SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id = 1)
          )
        );
    $sql$;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'pushsubs_insert_policy' AND polrelid = 'push_subscriptions'::regclass) THEN
      EXECUTE 'DROP POLICY pushsubs_insert_policy ON push_subscriptions';
    END IF;

    EXECUTE $sql$
      CREATE POLICY pushsubs_insert_policy ON push_subscriptions
        FOR INSERT
        WITH CHECK (
          -- allow inserts when visitor_id is provided (backend assigns)
          current_setting('app.user_id', true) IS NOT NULL
          OR true -- allow anonymous subscription insertion via public API if you choose
        );
    $sql$;
  END IF;
END$$;

-- cookie_consents: allow visitor to insert its own consent; restrict select to admin/editor
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'cookie_consents') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'cookieconsents_select_policy' AND polrelid = 'cookie_consents'::regclass) THEN
      EXECUTE 'DROP POLICY cookieconsents_select_policy ON cookie_consents';
    END IF;

    EXECUTE $sql$
      CREATE POLICY cookieconsents_select_policy ON cookie_consents
        FOR SELECT
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2))
        );
    $sql$;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'cookieconsents_insert_policy' AND polrelid = 'cookie_consents'::regclass) THEN
      EXECUTE 'DROP POLICY cookieconsents_insert_policy ON cookie_consents';
    END IF;

    EXECUTE $sql$
      CREATE POLICY cookieconsents_insert_policy ON cookie_consents
        FOR INSERT
        WITH CHECK (true);
    $sql$;
  END IF;
END$$;

-- visitors: allow inserts and select limited (admin/editor)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'visitors') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'visitors_select_policy' AND polrelid = 'visitors'::regclass) THEN
      EXECUTE 'DROP POLICY visitors_select_policy ON visitors';
    END IF;

    EXECUTE $sql$
      CREATE POLICY visitors_select_policy ON visitors
        FOR SELECT
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id IN (1,2))
        );
    $sql$;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'visitors_insert_policy' AND polrelid = 'visitors'::regclass) THEN
      EXECUTE 'DROP POLICY visitors_insert_policy ON visitors';
    END IF;

    EXECUTE $sql$
      CREATE POLICY visitors_insert_policy ON visitors
        FOR INSERT
        WITH CHECK (true);
    $sql$;
  END IF;
END$$;

-- notifications: allow admin only for select/insert/update/delete (example)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'notifications') THEN
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'notifications_admin_policy' AND polrelid = 'notifications'::regclass) THEN
      EXECUTE 'DROP POLICY notifications_admin_policy ON notifications';
    END IF;

    EXECUTE $sql$
      CREATE POLICY notifications_admin_policy ON notifications
        FOR ALL
        USING (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id = 1)
        )
        WITH CHECK (
          current_setting('app.user_id', true) IS NOT NULL
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = current_setting('app.user_id', true)::uuid AND u.role_id = 1)
        );
    $sql$;
  END IF;
END$$;

-- ---------------------------
-- 5. Quick verification queries (printed results when you run interactively)
-- ---------------------------

-- Show the roles we created (for verification)
-- SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('exotech_app','sprada_admin');

-- ---------------------------
-- 6. Final notes / instructions
-- ---------------------------
-- After running this migration:
--  1) Use the 'exotech_app' role for your backend connection. Replace 'change_this_app_password' with a secure secret.
--  2) In your app, for each request that operates on behalf of an authenticated user:
--       - Start a transaction: BEGIN
--       - SET LOCAL app.user_id = '<the-user-uuid>';
--       - (optionally) SET LOCAL app.user_role = '<role_name>';
--       - Run the DML (SELECT/INSERT/UPDATE/DELETE)
--       - COMMIT
--     Example (Node/pg):
--       await client.query('BEGIN');
--       await client.query("SET LOCAL app.user_id = $1", [userId]);
--       const res = await client.query('SELECT * FROM products WHERE slug = $1', [slug]);
--       await client.query('COMMIT');
--
--  3) Test RLS by connecting as exotech_app without setting app.user_id (you should only see published products).
--  4) For admin tasks, use the 'sprada_admin' role or grant your admin user the ability to connect as sprada_admin via controlled mechanism.
--  5) Consider creating a separate 'exotech_migrator' role for running schema changes, and keep sprada_admin only for trusted ops.
--
-- End of migration
