/* Portal SAG Web - Gate C / 003: security and core domain. SQL Server 2019. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51030, N'Wrong database.', 1;
IF SCHEMA_ID(N'migration') IS NULL THROW 51031, N'Run 002 first.', 1;
GO

BEGIN TRANSACTION;

CREATE TABLE security.users
(
  user_key                    BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  display_name                NVARCHAR(160) NOT NULL,
  email                       NVARCHAR(254) NOT NULL,
  email_normalized            NVARCHAR(254) NOT NULL,
  active                      BIT NOT NULL CONSTRAINT DF_users_active DEFAULT (1),
  password_hash               NVARCHAR(500) NULL,
  password_updated_at         DATETIME2(3) NULL,
  password_expires_at         DATETIME2(3) NULL,
  must_change_password        BIT NOT NULL CONSTRAINT DF_users_must_change DEFAULT (0),
  token_version               INT NOT NULL CONSTRAINT DF_users_token_version DEFAULT (0),
  last_login_at               DATETIME2(3) NULL,
  password_reset_token_hash   NVARCHAR(500) NULL,
  password_reset_expires_at   DATETIME2(3) NULL,
  password_reset_used_at      DATETIME2(3) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_users PRIMARY KEY CLUSTERED (user_key),
  CONSTRAINT UQ_users_source_id UNIQUE (source_id),
  CONSTRAINT UQ_users_email_normalized UNIQUE (email_normalized),
  CONSTRAINT CK_users_token_version CHECK (token_version >= 0),
  CONSTRAINT CK_users_email_normalized CHECK (email_normalized = LOWER(LTRIM(RTRIM(email_normalized)))),
  CONSTRAINT CK_users_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE security.roles
(
  role_id                     NVARCHAR(80) NOT NULL,
  name                        NVARCHAR(160) NOT NULL,
  active                      BIT NOT NULL CONSTRAINT DF_roles_active DEFAULT (1),
  system_role                 BIT NOT NULL CONSTRAINT DF_roles_system DEFAULT (0),
  protected_role              BIT NOT NULL CONSTRAINT DF_roles_protected DEFAULT (0),
  domain_task_visibility      VARCHAR(10) NOT NULL,
  database_task_visibility    VARCHAR(10) NOT NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_roles PRIMARY KEY CLUSTERED (role_id),
  CONSTRAINT UQ_roles_name UNIQUE (name),
  CONSTRAINT CK_roles_domain_visibility CHECK (domain_task_visibility IN ('none','assigned','all')),
  CONSTRAINT CK_roles_database_visibility CHECK (database_task_visibility IN ('none','assigned','all')),
  CONSTRAINT CK_roles_super_admin CHECK (role_id <> N'super_admin' OR (active = 1 AND system_role = 1 AND protected_role = 1))
);

CREATE TABLE security.permissions
(
  permission_key              NVARCHAR(160) NOT NULL,
  module_key                  NVARCHAR(80) NOT NULL,
  option_key                  NVARCHAR(100) NOT NULL,
  action_key                  NVARCHAR(80) NOT NULL,
  label                       NVARCHAR(200) NOT NULL,
  description                 NVARCHAR(500) NULL,
  active                      BIT NOT NULL CONSTRAINT DF_permissions_active DEFAULT (1),
  CONSTRAINT PK_permissions PRIMARY KEY CLUSTERED (permission_key),
  CONSTRAINT UQ_permissions_tuple UNIQUE (module_key, option_key, action_key)
);

CREATE TABLE security.role_permissions
(
  role_id                     NVARCHAR(80) NOT NULL,
  permission_key              NVARCHAR(160) NOT NULL,
  granted_at                  DATETIME2(3) NOT NULL CONSTRAINT DF_role_permissions_granted_at DEFAULT SYSUTCDATETIME(),
  granted_by                  NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_role_permissions PRIMARY KEY CLUSTERED (role_id, permission_key),
  CONSTRAINT FK_role_permissions_role FOREIGN KEY (role_id) REFERENCES security.roles(role_id),
  CONSTRAINT FK_role_permissions_permission FOREIGN KEY (permission_key) REFERENCES security.permissions(permission_key)
);

CREATE TABLE security.user_roles
(
  user_key                    BIGINT NOT NULL,
  role_id                     NVARCHAR(80) NOT NULL,
  assigned_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_user_roles_assigned_at DEFAULT SYSUTCDATETIME(),
  assigned_by                 NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_user_roles PRIMARY KEY CLUSTERED (user_key, role_id),
  CONSTRAINT FK_user_roles_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
  CONSTRAINT FK_user_roles_role FOREIGN KEY (role_id) REFERENCES security.roles(role_id)
);

CREATE TABLE security.auth_sessions
(
  session_key                 BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  user_key                    BIGINT NOT NULL,
  refresh_token_hash          BINARY(32) NOT NULL,
  token_version               INT NOT NULL,
  created_at                  DATETIME2(3) NOT NULL CONSTRAINT DF_auth_sessions_created DEFAULT SYSUTCDATETIME(),
  last_used_at                DATETIME2(3) NULL,
  expires_at                  DATETIME2(3) NOT NULL,
  revoked_at                  DATETIME2(3) NULL,
  revoked_reason              NVARCHAR(300) NULL,
  replaced_by_session_key     BIGINT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_auth_sessions PRIMARY KEY CLUSTERED (session_key),
  CONSTRAINT UQ_auth_sessions_source_id UNIQUE (source_id),
  CONSTRAINT UQ_auth_sessions_refresh_hash UNIQUE (refresh_token_hash),
  CONSTRAINT FK_auth_sessions_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
  CONSTRAINT FK_auth_sessions_replaced_by FOREIGN KEY (replaced_by_session_key) REFERENCES security.auth_sessions(session_key),
  CONSTRAINT CK_auth_sessions_token_version CHECK (token_version >= 0),
  CONSTRAINT CK_auth_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT CK_auth_sessions_revocation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE security.rate_limits
(
  rate_limit_key              BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  scope                       NVARCHAR(80) NOT NULL,
  key_type                    NVARCHAR(80) NOT NULL,
  key_hash                    BINARY(32) NOT NULL,
  attempt_count               INT NOT NULL,
  window_started_at           DATETIME2(3) NOT NULL,
  blocked_until               DATETIME2(3) NULL,
  expires_at                  DATETIME2(3) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_rate_limits PRIMARY KEY CLUSTERED (rate_limit_key),
  CONSTRAINT UQ_rate_limits_source_id UNIQUE (source_id),
  CONSTRAINT UQ_rate_limits_scope_key UNIQUE (scope, key_type, key_hash),
  CONSTRAINT CK_rate_limits_count CHECK (attempt_count >= 0),
  CONSTRAINT CK_rate_limits_expiry CHECK (expires_at >= updated_at)
);

CREATE TABLE core.environments
(
  environment_id              VARCHAR(20) NOT NULL,
  name                        NVARCHAR(80) NOT NULL,
  sort_order                  SMALLINT NOT NULL,
  active                      BIT NOT NULL CONSTRAINT DF_environments_active DEFAULT (1),
  CONSTRAINT PK_environments PRIMARY KEY CLUSTERED (environment_id),
  CONSTRAINT CK_environments_id CHECK (environment_id IN ('production','test','demo')),
  CONSTRAINT UQ_environments_sort UNIQUE (sort_order)
);

CREATE TABLE core.clients
(
  client_key                  BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  external_id                 NVARCHAR(100) NULL,
  name                        NVARCHAR(200) NOT NULL,
  name_normalized             NVARCHAR(200) NOT NULL,
  status                      VARCHAR(20) NOT NULL,
  notes                       NVARCHAR(MAX) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_clients PRIMARY KEY CLUSTERED (client_key),
  CONSTRAINT UQ_clients_source_id UNIQUE (source_id),
  CONSTRAINT CK_clients_status CHECK (status IN ('active','inactive','deleted')),
  CONSTRAINT CK_clients_delete CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR status <> 'deleted'),
  CONSTRAINT CK_clients_timestamps CHECK (updated_at >= created_at AND (deleted_at IS NULL OR deleted_at >= created_at))
);

CREATE UNIQUE INDEX UX_clients_external_id_active ON core.clients(external_id)
  WHERE external_id IS NOT NULL AND status <> 'deleted';
CREATE UNIQUE INDEX UX_clients_name_active ON core.clients(name_normalized)
  WHERE status <> 'deleted';

CREATE TABLE core.domains
(
  domain_key                  BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  client_key                  BIGINT NOT NULL,
  client_name_snapshot        NVARCHAR(200) NULL,
  domain_name                 NVARCHAR(500) NOT NULL,
  domain_name_normalized      NVARCHAR(500) NOT NULL,
  publishable_domain          NVARCHAR(500) NULL,
  environment_id              VARCHAR(20) NOT NULL,
  current_web_version         NVARCHAR(80) NULL,
  status                      VARCHAR(20) NOT NULL,
  notes                       NVARCHAR(MAX) NULL,
  last_updated_at             DATETIME2(3) NULL,
  last_updated_by             NVARCHAR(150) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_domains PRIMARY KEY CLUSTERED (domain_key),
  CONSTRAINT UQ_domains_source_id UNIQUE (source_id),
  CONSTRAINT UQ_domains_key_client UNIQUE (domain_key, client_key),
  CONSTRAINT FK_domains_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT FK_domains_environment FOREIGN KEY (environment_id) REFERENCES core.environments(environment_id),
  CONSTRAINT CK_domains_status CHECK (status IN ('active','inactive','deleted')),
  CONSTRAINT CK_domains_url CHECK (domain_name_normalized LIKE N'https://%'),
  CONSTRAINT CK_domains_delete CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR status <> 'deleted')
);

CREATE UNIQUE INDEX UX_domains_name_active ON core.domains(domain_name_normalized)
  WHERE status <> 'deleted';

CREATE TABLE core.domain_assignees
(
  domain_key                  BIGINT NOT NULL,
  user_key                    BIGINT NOT NULL,
  assigned_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_domain_assignees_assigned DEFAULT SYSUTCDATETIME(),
  assigned_by                 NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_domain_assignees PRIMARY KEY CLUSTERED (domain_key, user_key),
  CONSTRAINT FK_domain_assignees_domain FOREIGN KEY (domain_key) REFERENCES core.domains(domain_key),
  CONSTRAINT FK_domain_assignees_user FOREIGN KEY (user_key) REFERENCES security.users(user_key)
);

CREATE TABLE core.database_access_profiles
(
  access_profile_key          BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  public_id                   UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_database_access_public DEFAULT NEWSEQUENTIALID(),
  server_host_port            NVARCHAR(500) NOT NULL,
  initial_catalog             NVARCHAR(256) NOT NULL,
  sql_user_id                 NVARCHAR(256) NOT NULL,
  password_secret_name        NVARCHAR(256) NOT NULL,
  connection_fingerprint      BINARY(32) NOT NULL,
  active                      BIT NOT NULL CONSTRAINT DF_database_access_active DEFAULT (1),
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_database_access_profiles PRIMARY KEY CLUSTERED (access_profile_key),
  CONSTRAINT UQ_database_access_source_id UNIQUE (source_id),
  CONSTRAINT UQ_database_access_public_id UNIQUE (public_id),
  CONSTRAINT CK_database_access_secret CHECK (LEN(LTRIM(RTRIM(password_secret_name))) > 0),
  CONSTRAINT CK_database_access_timestamp CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX UX_database_access_fingerprint_active
  ON core.database_access_profiles(connection_fingerprint) WHERE active = 1;

CREATE TABLE core.databases
(
  database_key                BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  client_key                  BIGINT NOT NULL,
  client_name_snapshot        NVARCHAR(200) NULL,
  domain_key                  BIGINT NOT NULL,
  domain_name_snapshot        NVARCHAR(500) NULL,
  access_profile_key          BIGINT NOT NULL,
  company_name                NVARCHAR(240) NOT NULL,
  company_name_normalized     NVARCHAR(240) NOT NULL,
  environment_id              VARCHAR(20) NOT NULL,
  current_db_version          NVARCHAR(80) NULL,
  status                      VARCHAR(20) NOT NULL,
  notes                       NVARCHAR(MAX) NULL,
  last_updated_at             DATETIME2(3) NULL,
  last_updated_by             NVARCHAR(150) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_databases PRIMARY KEY CLUSTERED (database_key),
  CONSTRAINT UQ_databases_source_id UNIQUE (source_id),
  CONSTRAINT UQ_databases_key_client UNIQUE (database_key, client_key),
  CONSTRAINT UQ_databases_key_domain_client UNIQUE (database_key, domain_key, client_key),
  CONSTRAINT FK_databases_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT FK_databases_domain_client FOREIGN KEY (domain_key, client_key) REFERENCES core.domains(domain_key, client_key),
  CONSTRAINT FK_databases_access FOREIGN KEY (access_profile_key) REFERENCES core.database_access_profiles(access_profile_key),
  CONSTRAINT FK_databases_environment FOREIGN KEY (environment_id) REFERENCES core.environments(environment_id),
  CONSTRAINT CK_databases_status CHECK (status IN ('active','inactive','deleted')),
  CONSTRAINT CK_databases_delete CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR status <> 'deleted')
);

CREATE UNIQUE INDEX UX_databases_company_domain_active
  ON core.databases(domain_key, company_name_normalized) WHERE status <> 'deleted';

CREATE TABLE core.database_assignees
(
  database_key                BIGINT NOT NULL,
  user_key                    BIGINT NOT NULL,
  assigned_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_database_assignees_assigned DEFAULT SYSUTCDATETIME(),
  assigned_by                 NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_database_assignees PRIMARY KEY CLUSTERED (database_key, user_key),
  CONSTRAINT FK_database_assignees_database FOREIGN KEY (database_key) REFERENCES core.databases(database_key),
  CONSTRAINT FK_database_assignees_user FOREIGN KEY (user_key) REFERENCES security.users(user_key)
);

COMMIT TRANSACTION;
GO

PRINT N'003 complete: security and core tables created.';
GO
