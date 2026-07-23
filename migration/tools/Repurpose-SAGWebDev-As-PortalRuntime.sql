/*
  RETIRED BY OWNER DECISION 2026-07-23.

  Portal database patching must preserve the effective SAGWebDev role
  memberships and grants. This artifact is retained only so historical
  references fail closed instead of silently downgrading the login.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

THROW 51900, N'DISABLED: the owner-directed permission-preservation policy forbids downgrading SAGWebDev.', 1;
