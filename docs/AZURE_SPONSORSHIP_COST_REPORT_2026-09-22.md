# Azure Sponsorship Cost Report

**Prepared:** 2026-09-22  
**Subscription:** `Pago por uso` (`edbbf624-b155-4c51-ac57-d02424a7234d`)  
**Actual offer:** Azure Sponsorship (`MS-AZR-0036P`)  
**Billing identity shown by Microsoft:** Camilo Palacio  
**Currency:** USD

## Executive finding

The subscription is named `Pago por uso`, but Azure identifies it as an **Azure
Sponsorship** offer. This is why the normal Azure Cost Management and
Consumption APIs return no cost rows; the authoritative ledger is the Microsoft
Azure Sponsorships portal.

The sponsorship balance page reported:

- Total credit: **$2,400**
- Used: **$1,686** (rounded balance figure)
- Remaining: **$714**
- Offer period: **2026-06-17 through 2027-01-07**
- Offer expiry: **107 days remaining**
- Itemized usage through 2026-09-22: **$1,684.86**

At the September rate of **$18.41/day** (about **$552/month**), the remaining
credit lasts approximately **39 days**, until about **2026-10-31**. To make the
credit last until 2027-01-07, spending must fall to approximately **$200/month**,
a reduction of about **64%** from the current run rate.

No Azure resource, tag, subscription, billing scope, or sponsorship label named
`Best Ball` was visible. Azure shows the sponsorship under Camilo Palacio and
offer `MS-AZR-0036P`.

## Spend trend

| Period | Actual spend | Daily rate |
|---|---:|---:|
| 2026-06-17 to 2026-06-30 | $193.73 | $13.84 |
| July 2026 | $498.67 | $16.09 |
| August 2026 | $587.44 | $18.95 |
| 2026-09-01 to 2026-09-22 | $405.01 | $18.41 |

Spending increased materially after activation and is now tracking near the
August peak.

## Where the credit went

The following totals are the authoritative sponsorship ledger for
2026-06-17 through 2026-09-22 (98 days).

| Cost family | Actual spend | Share | Approx. monthly equivalent |
|---|---:|---:|---:|
| App Service plans | $1,076.96 | 63.92% | $329.68 |
| Azure AI Search | $232.10 | 13.78% | $71.05 |
| SQL Database | $156.80 | 9.31% | $48.00 |
| Networking (NAT, load balancer, bandwidth, public IPs) | $141.29 | 8.39% | $43.25 |
| Container Apps and Container Registry | $60.42 | 3.59% | $18.50 |
| Log Analytics | $9.76 | 0.58% | $2.99 |
| Storage operations and data | $6.37 | 0.38% | $1.95 |
| Functions | $0.77 | 0.05% | $0.24 |
| Other | $0.39 | 0.02% | $0.12 |

The first five families account for approximately **98.99%** of all spend.

## Charged resources and application mapping

### App Service: $1,076.96 (largest cost family)

App Service is billed at the **plan** level, not per application. Stopping one
application does not stop plan charges; savings require downsizing, moving all
applications off a plan, or deleting the plan.

| Charged SKU | Actual spend | Approx. monthly | Azure plan | Applications | 30-day evidence |
|---|---:|---:|---|---|---|
| S2 App | $459.20 | $140.57 | `Develop` | `facturaelectronicapya`, `wssagrest`, `sag-erp`, `wssagpya`, `portalsag`, `SAGAdmin`, `intermediario`, `wscausacion` | Active shared production plan. `wssagpya` had 7.54M requests; `intermediario` had 237.6K. Plan avg memory 55%, peaks 99%. |
| P0v4 | $307.80 | $94.22 | `ASP-apps-83cd` | `wscausarxml` | **Only 4 requests in 31 days**, 114 CPU-seconds, 18 MB average application memory. Clearest waste candidate. |
| S1 App | $229.60 | $70.29 | `ASP-mpn2019-af37` | `ApiFeSag`, `apiSagMovilPro` | Active: 1.64M and 312.6K requests. Plan avg memory 79.6%, peaks 99%; do not downsize blindly. |
| B1 | $41.33 | $12.65 | `ASP-ChatbotSAGWeb-8ee2` | `chatbot-sag-web` | Active: 9,357 requests; plan avg memory 71%. |
| B1 | $39.03 | $11.95 | `asp-the-dictator` | `the-dictator-35f6f9` | Active: 1,122 requests; plan avg memory 71%. |

Low-activity applications inside the shared `Develop` plan include:

- `SAGAdmin`: 2 requests in 30 days
- `wscausacion`: 43 requests in 30 days
- `portalsag`: 1,514 requests in 30 days
- `facturaelectronicapya`: 2,295 requests in 30 days

Removing these alone does not reduce the S2 charge because the heavy
applications remain on the same plan, but it can reduce memory pressure and may
enable a later plan downgrade after validation.

### Azure AI Search: $232.10

- Resource: `sagweb-ia-chatbot`
- SKU: Basic
- Capacity: 1 replica, 1 partition
- Approximate monthly cost: **$71.05**
- Related application: `chatbot-sag-web`

Basic Search is a continuously billed fixed resource. The chatbot is active, so
this service should not be removed without confirming the search dependency.
If the chatbot can be retired or redesigned, this is the second-largest clean
fixed-cost target after P0v4.

### SQL Database: $156.80

The ledger includes **$138.88 for S0 DTUs** and **$17.92 for General Purpose
storage**.

| Database | SKU | Used size | Successful connections (30d) | Peak DTU (30d) |
|---|---|---:|---:|---:|
| `sagdevelop/SAGAdmin_db` | S0 | 44.6 MB | 1 | 4% |
| `sagdevelop/SAGWebDB1` | S0 | 83.0 MB | 0 | 0% |
| `sagdevelop/SAGWebDB2` | S0 | 129.2 MB | 0 | 0% |

All three are tiny enough to fit within the Basic tier's size limit, subject to
application compatibility. They appear idle. Downgrading all three from S0 to
Basic should reduce the approximately **$42.50/month S0 compute charge** to
roughly Basic-tier pricing. Exporting and removing confirmed-obsolete databases
would eliminate it.

The serverless databases (`acceso_portales` and `chatbot`) did not show paid
compute in the sponsorship ledger for this period; `acceso_portales` was paused,
and the chatbot database used its free allowance.

### Guide Builder / Container Apps stack

Resources in `rg-erp-update-scheduler-prod` are responsible for a recurring
combination of compute and dedicated networking costs:

- Container Apps active vCPU: $40.56
- Container Apps active memory: $10.14
- NAT Gateway fixed charge and data: $61.29
- Standard Load Balancer: $33.94
- Standard public IPs: part of $13.56
- Container Registry Basic and task compute: $9.72
- Related Log Analytics ingestion: part of $9.76

The production job `erpupdsch4645-guide-prod-job` runs on a `*/5 * * * *`
schedule: **every five minutes**, typically for about one minute. This is about
8,640 executions per 30-day month. The QA job is manual.

Reducing the schedule frequency can lower Container Apps compute, but it does
not remove the NAT Gateway, load balancer, public IP, registry, or environment
fixed costs. Removing those fixed costs requires redesigning or retiring the
dedicated networked Container Apps environment.

## Prioritized containment plan

### Priority 1 — highest confidence, low observed activity

1. **Resolve `wscausarxml` / `ASP-apps-83cd` immediately.**
   - Current run rate: approximately $94/month.
   - Evidence: only 4 requests in 31 days.
   - Savings require deleting the plan or moving/downgrading the application;
     stopping only the web app does not stop the plan charge.
   - First choice if obsolete: back up configuration/content, then remove the
     app and plan.
   - If still required: test a substantially cheaper tier.

2. **Downgrade or archive the three idle S0 databases.**
   - Potential saving: approximately $30-$43/month depending on whether they
     are moved to Basic or removed after export.
   - Validate connection strings and take exports before any destructive action.

### Priority 2 — intentional product decision

3. **Reduce the Guide Builder polling schedule.**
   - Change from every five minutes to an interval aligned with business need.
   - Potential compute reduction: up to about $14/month if changed to hourly,
     based on execution frequency; fixed network costs remain.

4. **Review whether dedicated Guide Builder networking is required.**
   - NAT Gateway, load balancer, and public IPs account for roughly $33-$43/month.
   - Removing them may affect fixed outbound IP, SQL allowlists, and production
     connectivity. This requires an architecture change, not a blind shutdown.

5. **Confirm whether Azure AI Search is still required.**
   - Potential saving: about $71/month if the chatbot/search workload can be
     retired or migrated.
   - The chatbot has recent traffic, so do not delete Search without dependency
     validation.

### Priority 3 — optimize, do not abruptly stop

6. **Keep the S1 plan until performance testing says otherwise.**
   Its two APIs are heavily used and memory utilization is high.

7. **Optimize the S2 shared plan.**
   It is the largest single charge, but carries the highest-traffic application.
   Investigate `wssagpya` memory and request volume, remove unused apps, and run
   a controlled S1 capacity test before considering a downgrade.

## Required reduction

Removing or sharply reducing P0v4, the idle S0 databases, and the Guide Builder
stack could save roughly **$175-$190/month**. Removing Azure AI Search as well
could raise savings to roughly **$245-$260/month**. Even that may leave the
subscription near **$290-$310/month**, above the **$200/month** target needed to
last through the sponsorship expiry. Reaching the full target likely requires an
additional App Service optimization, especially in the S2 plan.

## Safety note

This investigation was read-only. No Azure resource was stopped, resized,
deleted, or reconfigured. Any shutdown, tier change, schedule change, or database
retirement should be performed as a separately authorized action with dependency
checks and a rollback plan.
