/**
 * Fixed b/r aliases in sealed head readers. 052 verifies the immutable Company
 * count at sealing; NULL (missing) and 0 (observed empty) are not interchangeable.
 * These predicates prove a readable revision, not absence or coverage.
 */
export const catalogSagV1LicenseRevisionSql = `b.contract_version COLLATE Latin1_General_100_BIN2='sag_admin_v1'
    AND r.expected_sag_company_rows IS NULL AND DATALENGTH(b.contract_version)=12`;

export const catalogSagPositiveLicenseRevisionSql = `(
  r.sealed_at IS NOT NULL AND r.has_sag_inventory_evidence=1
  AND ((${catalogSagV1LicenseRevisionSql})
    OR (b.contract_version COLLATE Latin1_General_100_BIN2='sag_admin_v2'
      AND r.expected_sag_company_rows IS NOT NULL AND DATALENGTH(b.contract_version)=12))
)`;
