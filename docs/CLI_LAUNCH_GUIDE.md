# Launch and find users

Goal: get developers to run a real storage report and learn whether they need it repeatedly. A free utility is useful even if the hosted business does not work. Do not treat those as the same outcome.

## What to say

One sentence:

> TenantMeter is a free local CLI that reports storage usage per customer in an existing S3 or R2 bucket.

Supporting points:

- Uses your existing object paths, such as `customers/{tenant_id}/*`.
- Lists metadata; never downloads files or changes the bucket.
- Shows matched and unmatched usage; exports CSV and JSON.
- No hosted account or credential handoff. No telemetry.
- Supports bounded and resumable scans.

Do not claim exact cloud costs, invoice-ready billing, real-time quotas, proven provider compatibility before live tests, or customer savings you have not measured.

## Prepare the launch material

1. Complete the release checks in [CLI_NEXT_STEPS.md](CLI_NEXT_STEPS.md).
2. Publish under a repository and npm scope you control.
3. Make the repository README start with installation, demo, sample output, and the S3/R2 examples.
4. Use the fake-data reports in [examples](examples/) for screenshots. Label them synthetic.
5. Record a 60–90 second terminal video: demo, a fake pattern, top customers, unmatched usage, CSV export.
6. Add one feedback route: GitHub issues or a monitored email. Replace placeholders below with real links.
7. Offer a small number of setup sessions. Do not request production credentials or customer files.
8. Keep the initial call to action simple: “Run it and tell me whether this replaces something you maintain.”

## Where to promote, in order

| Priority | Place | What to share | How to assess it |
| --- | --- | --- | --- |
| 1 | [GitHub](https://github.com/) | Public source, usable README, releases, issue template | Installation issues and voluntary reports of real use |
| 1 | [DEV](https://dev.to/) or your own blog | One technical walkthrough with working commands | Relevant readers who try a scan |
| 1 | Relevant existing AWS/R2 discussions | A useful answer; disclose authorship when linking the tool | People with an active measurement problem |
| 2 | [Show HN](https://news.ycombinator.com/showhn.html) | A working tool anyone can try, with the credential-free demo | Useful feedback and real trials; traffic alone is weak evidence |
| 2 | [r/aws](https://www.reddit.com/r/aws/) and [r/CloudFlare](https://www.reddit.com/r/CloudFlare/) | Technical explanation or a permitted project post | Feedback from actual bucket operators |
| 2 | Cloudflare developer community, reached through [official docs](https://developers.cloudflare.com/) | A relevant R2 usage example in an allowed channel | R2-specific setup and workflow feedback |
| 3 | [Indie Hackers](https://www.indiehackers.com/) | What you built, limitations, and the use case | Founder feedback; qualify storage needs before counting demand |
| Later | [Product Hunt](https://www.producthunt.com/launch) | A clearer product after real-user feedback | Lower priority than targeted developer channels |

Read each community's current rules before posting. Reddit rules were not publicly readable through the research tool; no promotional permission is assumed. Cloudflare community entry points can change; follow the links from its official docs. Do not post tool advertisements in unrelated GitHub issues, revive old threads solely for promotion, cross-post identical pitches everywhere, or privately message community members without an appropriate invitation.

Show HN expects something people can use; a waitlist-only page is not the launch artifact. See its [guidelines](https://news.ycombinator.com/showhn.html).

## First technical article

Title: **How to report S3 and R2 storage usage per customer**

Outline:

1. Show the input: `customers/acme/file.pdf`, `customers/northwind/photo.png`.
2. Explain the task: sum current object sizes by the customer segment.
3. Show the demo and its synthetic report.
4. Show one AWS command using a local profile.
5. Show one R2 command using environment credentials.
6. Explain listing charges, the default object limit, and how resume works.
7. Explain unmatched objects and scope when using `--prefix`.
8. Explain the alternatives: application counters, Inventory/Athena, Storage Lens.
9. State the limitations: changing buckets, old versions, daily peaks, and billing semantics.
10. End with installation and one request for feedback.

Use one good article before making many keyword pages. Useful search phrases to include naturally are “S3 storage by prefix,” “storage usage per customer,” “R2 storage by tenant,” and “S3 tenant storage report.” Search volume and conversion rates have not been established.

## Where to find companies for direct outreach

Start with products that store customer documents, photos, video, design assets, backups, or archives. An engineering lead or technical founder is usually a better first contact than finance for a CLI trial. This is a targeting hypothesis, not an established buyer profile.

Find companies through:

1. Product directories and comparison pages for digital asset management, document management, client portals, and media review tools.
2. Their own pricing pages: included GB/TB, storage add-ons, and overage charges.
3. Their documentation, engineering blogs, and job pages: explicit evidence of S3 or R2 usage.
4. Recent public discussions describing storage measurement or counter drift.
5. Agency case studies describing several file-heavy SaaS builds; an agency may bring access to multiple relevant projects.
6. Existing professional contacts who can introduce you to the person maintaining uploads, storage limits, or billing.

Copy these search queries and refine by category:

```text
"digital asset management" "additional storage" pricing
"document management" "storage overage"
"client portal" "storage limit" pricing
"video review" "storage" pricing
"SaaS" "Amazon S3" "engineering"
"SaaS" "Cloudflare R2"
"S3" "per customer" "storage usage"
"S3" "per tenant" "billing"
"R2" "storage" "quota" "tenant"
site:reddit.com/r/aws "size" "prefix"
site:github.com "storage usage" "tenant" "S3"
"COMPANY NAME" "S3"
"COMPANY NAME" "R2"
"COMPANY NAME" engineering team
```

GitHub repositories identify workflows and possible integration communities, not automatically buyers. A library that already solves accounting may be a substitute. A company advertising storage add-ons may also have perfectly reliable counters.

## Gather this before contacting someone

Use [outreach/prospects.csv](outreach/prospects.csv). Keep it local; do not publish a spreadsheet of personal contact data.

1. Company name, website, product category, and rough team size if public.
2. Pricing URL and the exact storage allowance or add-on they publish.
3. S3/R2 evidence URL, what it says, and date checked. Write “unknown” instead of guessing.
4. A public pain signal, if one exists; distinguish current problems from old discussions.
5. Whether mapping by customer prefix appears possible. Usually this is unknown until they answer.
6. A relevant person and role, sourced from the company team page or their public professional profile.
7. A published business contact route or an introduction. A public email is not proof of permission to send marketing.
8. One sentence explaining why this report could fit their workflow.
9. Contact permission/rules checked, country if known, outreach date, response, next step, and any opt-out.

Do not buy a large email list, guess thousands of addresses, or collect production bucket names and credentials. Start with ten companies for which you can write a credible, specific reason to reach out.

Prioritize candidates using a simple score:

- 2 points: public storage allowances or overage pricing.
- 2 points: explicit S3/R2 evidence.
- 2 points: recent measurement, quota, or counter-drift problem.
- 1 point: relevant contact or warm introduction available.

Scores help allocate attention; they are not probability estimates. A high score without a reachable contact is still not a usable lead.

## Research starting points, not qualified leads

| Source | What it proves | What it does not prove |
| --- | --- | --- |
| [AWS/Kaltura case study](https://aws.amazon.com/blogs/storage/getting-visibility-into-storage-usage-in-multi-tenant-amazon-s3-buckets/) | Tenant storage measurement matters at scale | Kaltura needs this CLI or is an appropriate early customer |
| [Zetcom published SaaS terms](https://www.zetcom.com/wp-content/uploads/2024/10/Specification-SaaS-contract-incl.-maintenance-and-support_EN-AWS-1.pdf) | An asset-management vendor publishes additional S3 storage pricing | Its present accounting is unreliable or terms are unchanged |
| [Laracrate](https://github.com/edulazaro/laracrate) | Developers implement tenant reporting and counter recomputation | Maintainers or users will pay for a hosted service |
| [Public per-tenant AWS cost question](https://www.reddit.com/r/Cloud/comments/1wauwe6/how_can_i_get_pertenant_aws_cost_in_a_shared/) | Someone describes an allocation problem | A storage-only tool solves their broader problem |

Check sources again before using them. No personal emails or purchasing intent have been verified.

## Where to email, and who

Prefer a warm introduction, someone who explicitly asked to try the tool, or a public business contact route that welcomes relevant product/engineering inquiries. Use the company website or the person's public professional page to identify the route. Avoid unrelated support/security inboxes and private addresses collected from leaked data.

For a small SaaS, aim for the technical founder. For a larger team, aim for the engineering lead responsible for file storage, platform engineering, or billing infrastructure. For an agency, aim for the technical lead who repeatedly builds upload and storage features.

Before unsolicited promotional email, check the rules that apply to the sender and recipient. Being a free tool or using a business address does not automatically exempt a message. Greece's DPA describes electronic marketing as opt-in with specific exceptions; do not treat this guide as permission for a Greek cold-email campaign. [Greek DPA guidance](https://www.dpa.gr/en/by-design/online-marketing-and-advertising-cookies-and-trackers). For US outreach, consult the [FTC CAN-SPAM guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business), including identity, address, and opt-out requirements. Where permission is unclear, use public, permitted promotion or introductions to obtain interested testers.

Keep a suppression list in [outreach/do-not-contact.csv](outreach/do-not-contact.csv). An opt-out overrides any planned follow-up.

## Email draft

Use only when the contact route and applicable rules permit it. Replace every bracketed field; do not invent pain or claim to have inspected their bucket.

```text
Subject: Storage usage per customer at [Company]

Hi [Name],

I saw [specific fact and source: e.g. your storage add-on on the pricing page].

I built TenantMeter, a free open-source CLI that reports storage per customer
from an existing S3/R2 bucket. It runs locally with your credentials and only
lists metadata. No account or bucket changes.

Here is the example report and demo: [one real link].

Would this replace a script or report you currently maintain? If so, I'd like
to help you try a small scan. No credentials or customer files need to be shared.

[Your name and company/contact details]
[Required postal address where applicable]
If this is not relevant, reply and I will not follow up.
```

One follow-up, about a week later, only where permitted and only if they have not opted out:

```text
Hi [Name],

One follow-up on the storage report tool: [link].
If your application already keeps reliable per-customer totals, this may add
little value. If reconciling those totals is a recurring task, I'd be interested
in how you handle it.

[Your name and required contact details]
No reply needed if it is not useful; I will stop here.
```

Do not create an automated follow-up sequence for the first ten prospects. Read each reply and adapt.

## Public launch draft

```text
Title: Show HN: TenantMeter – local S3/R2 storage reports per customer

I built a small open-source CLI for SaaS teams whose object paths contain
customer IDs, such as customers/acme/files/....

It lists keys and sizes, groups storage by customer, reports unmatched objects,
and exports CSV or JSON. It runs locally, has no telemetry, and never reads
object payloads or changes the bucket. It supports a scan cap and resume.

You can try the fake-data demo without cloud credentials: [real instructions].
Source and example report: [real link].

It measures current listed files, not time-weighted usage or a provider bill.
Application counters, S3 Inventory, and Storage Lens may already solve your
problem. I'm interested in whether a local report is useful for reconciliation
or storage allowances, and what gets in the way of trying it.
```

Use a shorter, context-specific version for other communities; follow their rules and disclose that you built it.

## Questions after a real trial

1. Did installation work? What OS and Node version?
2. Did the pattern match your customer paths?
3. Did the scan finish? Roughly how many objects and how long?
4. Did the totals match your expectations or existing counters?
5. Did the report change a decision, reveal a mismatch, or save a task?
6. Would you run it again? When and why?
7. Would you prefer local scheduling or a hosted service?
8. If hosted reports solved that recurring task, would you pay? Offer a concrete trial with a stated price and deliverable instead of accepting a vague yes.

Request only redacted commands and optional summary counts. Do not ask users to send customer identifiers, reports, or credentials.

## Four-week work plan

1. Week 1: complete provider checks, publish the package/repository, prepare the demo and article, research ten prospects.
2. Week 2: publish the article, share in one permitted relevant community, and invite the first five appropriate contacts.
3. Week 3: fix onboarding problems, invite five more contacts, and post Show HN when the package is usable.
4. Week 4: follow up where permitted, review real trials, and offer a specific recurring-report pilot to interested users.

Use [outreach/experiments.csv](outreach/experiments.csv) to record channel, date, time spent, qualified replies, confirmed scans, repeat-use requests, and paid pilots. Track voluntary feedback; the CLI has no tracking. Lack of feedback is not proof that nobody used it.

Decision rules are hypotheses, not market benchmarks:

- Several successful real scans with repeated requests for scheduling/history: test a paid recurring report.
- Successful scans but mostly one-time use: keep it as a utility; do not assume a subscription business.
- Installation failures: fix distribution before judging demand.
- Few relevant people reached: revisit targeting and channels; the market is still untested.
- Prospects understand it, try it, and consistently prefer existing counters: reconsider the proposition.

The strongest evidence is a report used in an actual operational process and payment for repeating that process. Stars, downloads, friendly replies, and waitlist signups are weaker evidence.
