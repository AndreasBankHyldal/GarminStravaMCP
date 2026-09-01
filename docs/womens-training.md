# Women's Training and Menstrual-Health Tools

Research review date: **2026-09-01**

These tools provide educational decision support for training and fueling. They
do not diagnose, treat, provide contraception, confirm ovulation, or replace a
qualified clinician or sports dietitian.

## Setup

The entire feature group is disabled by default. This means a default or male
profile receives no women-specific tools, prompts, or server instructions.

To enable the locally stored cycle, symptom, readiness, nutrition, screening,
and pattern tools:

```env
I_AM_WOMAN=true
```

Then restart the MCP server. Configure Garmin normally if recovery data should
be pulled:

```env
GARMIN_USERNAME=your.email@example.com
GARMIN_PASSWORD=your_password
```

If the account uses MFA, run:

```bash
npm run garmin-auth
```

Period starts and symptoms can now be recorded with
`women_log_daily_health`; Garmin reproductive endpoints are not required.

To additionally expose Garmin menstrual-calendar/day and pregnancy-snapshot
reads, first enable Women's Health in Garmin Connect, log/sync the data, review
the privacy limitations below, and set both:

```env
I_AM_WOMAN=true
GARMIN_WOMENS_HEALTH_ENABLED=true
```

`GARMIN_WOMENS_HEALTH_ENABLED=true` has no effect while `I_AM_WOMAN=false`.

## Design principle

The most reliable current conclusion is not that each menstrual phase needs a
different training plan. A 2020 systematic review and meta-analysis found only
trivial average performance differences, low-quality underlying evidence, and
large individual variation. The tools therefore:

- use current symptoms, sleep, HRV relative to personal baseline, resting heart
  rate, and recent load before cycle phase;
- never add or remove a hard workout solely because of an estimated phase;
- express calendar phase as a probability with low/moderate confidence;
- compare the athlete's own repeated patterns across completed cycles;
- prioritize low energy availability, menstrual dysfunction, iron risk, heavy
  bleeding, pregnancy, and bone-stress warning signs.

## Tools

| Tool | Purpose |
|---|---|
| `women_set_health_profile` | Store life stage, contraception context, and usual cycle length locally |
| `women_log_daily_health` | Log confirmed period starts/LH tests, symptoms, energy, fatigue, sleep, and session response |
| `women_delete_cycle_event` | Correct an incorrectly recorded cycle event |
| `women_get_cycle_context` | Return a probabilistic calendar estimate and its assumptions |
| `garmin_get_recovery_snapshot` | Pull sleep/need, HRV, resting HR, Body Battery change, load/recovery, hydration, weight, VO2max, respiration, Pulse Ox, and available skin temperature |
| `garmin_get_extended_wellness` | Return raw Body Battery and stress documents without guessing undocumented fields |
| `women_get_training_context` | Combine symptoms and Garmin recovery data into a transparent green/yellow/orange/red context |
| `women_get_nutrition_targets` | Calculate workload-based carbohydrate, protein, recovery, and hydration ranges |
| `women_estimate_energy_availability` | Calculate an uncertainty-aware educational energy-availability estimate |
| `women_screen_training_health` | Flag menstrual, bleeding, iron, bone, pregnancy, and under-fueling concerns for clinical review |
| `women_analyze_cycle_training_patterns` | Compare personal activity and symptom summaries across completed cycles |

When explicit Garmin reproductive-health opt-in is enabled, three additional
read-only tools are registered:

- `garmin_get_menstrual_day`
- `garmin_get_menstrual_calendar`
- `garmin_get_pregnancy_summary`

## Garmin data access and privacy

Garmin's official Women's Health API is part of its business-only Developer
Program and requires partner approval. This personal MCP already uses an
unofficial Garmin Connect consumer API. All women-specific tools are gated by
`I_AM_WOMAN=true`; the reproductive-health endpoints require an additional,
separate opt-in outside the assistant:

```env
I_AM_WOMAN=true
GARMIN_WOMENS_HEALTH_ENABLED=true
```

This is a separate opt-in because reproductive-health data is especially
sensitive. The private endpoints can change without notice, have no published
response schema, and may carry Garmin terms-of-use risk. The implementation:

- performs read-only `GET` requests;
- never logs or auto-saves the raw payload;
- treats response JSON as opaque;
- labels discovered date fields as `unverified`;
- requires the user to record confirmed period starts explicitly before they
  affect local cycle estimates.

General recovery signals use the same unofficial Garmin session. Every returned
field includes source context, and missing data is reported rather than
invented. Strava supplies activities only; it cannot supply menstrual data,
sleep, HRV, stress, Body Battery, or training readiness.

## Cycle estimates

Calendar counting cannot confirm ovulation. The estimate uses:

1. confirmed period-start dates;
2. the athlete's median observed cycle length when available;
3. usual cycle/period length as a fallback;
4. an approximate 14-day luteal phase only as a population estimate;
5. an optional positive urinary LH test, which supports an approaching
   ovulation window but does not prove ovulation.

Confidence is never reported as high. Hormonal contraception, pregnancy,
postpartum, postmenopause, marked irregularity, or at least 90 days without a
recorded period disables reliable natural-phase estimation. The estimate must
not be used to achieve or prevent pregnancy.

## Training context

The context result is explainable rather than a proprietary readiness score:

- **Green:** available symptom/recovery data does not suggest a change.
- **Yellow:** extend the warm-up and consider a 0-15% adjustment.
- **Orange:** consider easy training/rest and a 15-40% adjustment.
- **Red:** stop automated training advice because a medical warning sign was
  reported.
- **Insufficient data:** phase alone cannot produce a positive readiness result.

Adjustment ranges are options for self-observation, not prescriptions. Garmin
Body Battery is treated as a limited, proprietary supporting signal. HRV is
compared with the personal baseline; small menstrual-cycle HRV changes are not
treated as deterministic.

## Fueling model

Targets follow the 2016 ACSM/Academy/Dietitians of Canada position statement:

| Training demand | Daily carbohydrate |
|---|---:|
| Light | 3-5 g/kg/day |
| Moderate | 5-7 g/kg/day |
| High (about 1-3 h/day) | 6-10 g/kg/day |
| Very high (about 4-5+ h/day) | 8-12 g/kg/day |

Additional starting ranges:

- 1-4 g/kg carbohydrate 1-4 hours before a demanding session;
- 30-60 g carbohydrate/hour for roughly 1-2.5 hours;
- up to 60-90 g/hour after about 2.5 hours, using practiced
  multiple-transportable carbohydrate sources;
- 1.2-2.0 g protein/kg/day, distributed in roughly 0.25-0.4 g/kg meals;
- 1.0-1.2 g carbohydrate/kg/hour for the first four hours only when another
  demanding session follows within about eight hours;
- at least 20% of energy from fat;
- individual fluid planning from sweat rate, while avoiding exercise-associated
  weight gain from over-drinking.

Energy adequacy comes before macro distribution. The tool never changes these
ranges solely by menstrual phase.

## Health guardrails

The health screen is deliberately not called CAT2, RED-S CAT2, a Triad score, or
a validated questionnaire.

It recommends prompt clinical review for repeated adult cycles outside roughly
24-38 days, cycle-length variation over about 9 days, no period for at least 90
days, no first period by age 15, bone-stress injury, prolonged/heavy bleeding,
restrictive eating, rapid weight loss, or clusters of iron/under-fueling
indicators.

It escalates chest pain or fainting during exercise, severe pelvic pain with
possible pregnancy, bleeding during possible/known pregnancy, or very heavy
bleeding with dizziness, breathlessness, or chest pain. Emergency care depends
on local services and clinical severity.

The energy-availability formula is:

```text
(dietary energy intake - exercise energy expenditure) / fat-free mass
```

The historic 30 and 45 kcal/kg fat-free-mass/day values are shown only as
uncertain reference points. The 2023 IOC RED-S consensus discourages diagnosis
from one universal threshold. Numeric estimates are withheld for athletes under
18, and restriction/weight-loss guidance is suppressed when under-fueling or
disordered-eating concerns are present. The software never recommends an iron
supplement dose; laboratory interpretation and treatment belong with a
clinician.

## Evidence base

- McNulty KL et al. *The Effects of Menstrual Cycle Phase on Exercise
  Performance in Eumenorrheic Women: A Systematic Review and Meta-Analysis.*
  Sports Medicine (2020). [doi:10.1007/s40279-020-01319-3](https://doi.org/10.1007/s40279-020-01319-3)
- Elliott-Sale KJ et al. *The Effects of Oral Contraceptives on Exercise
  Performance in Women: A Systematic Review and Meta-analysis.* Sports Medicine
  (2020). [doi:10.1007/s40279-020-01317-5](https://doi.org/10.1007/s40279-020-01317-5)
- Elliott-Sale KJ et al. *Methodological Considerations for Studies in Sport
  and Exercise Science with Women as Participants.* Sports Medicine (2021).
  [doi:10.1007/s40279-021-01435-8](https://doi.org/10.1007/s40279-021-01435-8)
- Mountjoy M et al. *2023 IOC consensus statement on Relative Energy Deficiency
  in Sport (REDs).* BJSM (2023).
  [doi:10.1136/bjsports-2023-106994](https://doi.org/10.1136/bjsports-2023-106994)
- Stellingwerff T et al. *Development and validation of the IOC REDs CAT2.*
  BJSM (2023).
  [doi:10.1136/bjsports-2023-106914](https://doi.org/10.1136/bjsports-2023-106914)
- De Souza MJ et al. *2014 Female Athlete Triad Coalition Consensus Statement.*
  BJSM (2014).
  [doi:10.1136/bjsports-2013-093218](https://doi.org/10.1136/bjsports-2013-093218)
- De Souza MJ et al. *2025 Update to the Female Athlete Triad Coalition
  Consensus Statement Part 1.* Sports Medicine (published 2026).
  [doi:10.1007/s40279-025-02333-z](https://doi.org/10.1007/s40279-025-02333-z)
- Thomas DT, Erdman KA, Burke LM. *Nutrition and Athletic Performance.* MSSE
  (2016).
  [doi:10.1249/MSS.0000000000000852](https://doi.org/10.1249/MSS.0000000000000852)
- Sims ST et al. *ISSN position stand: nutritional concerns of the female
  athlete.* JISSN (2023).
  [doi:10.1080/15502783.2023.2204066](https://doi.org/10.1080/15502783.2023.2204066)
- Sim M et al. *Iron considerations for the athlete.* European Journal of
  Applied Physiology (2019).
  [doi:10.1007/s00421-019-04157-y](https://doi.org/10.1007/s00421-019-04157-y)
- Shi Y et al. *Wearable digital technology in detecting fertility window and
  menstrual cycles: systematic review and Bayesian network meta-analysis.* npj
  Digital Medicine (2026).
  [doi:10.1038/s41746-025-02320-8](https://doi.org/10.1038/s41746-025-02320-8)
- de Jager E et al. *Wearable-Derived HRV Across the Menstrual Cycle,
  Contraceptive Use, and Reproductive Life Stages.* Sports Medicine (2026).
  [doi:10.1007/s40279-025-02388-y](https://doi.org/10.1007/s40279-025-02388-y)
- Munro MG, Critchley HOD, Fraser IS. *The FIGO systems for normal and abnormal
  uterine bleeding symptoms and classification.* IJGO (2018).
  [doi:10.1002/ijgo.12666](https://doi.org/10.1002/ijgo.12666)
- NICE. *Heavy menstrual bleeding: assessment and management (NG88).*
  [nice.org.uk/guidance/ng88](https://www.nice.org.uk/guidance/ng88)
