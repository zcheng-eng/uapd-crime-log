"""Crosswalk from UAPD's raw "Nature of Crime" and "Disposition" labels to broad groups.

UAPD switched label formats around July-August 2026 (e.g. "LARCENY/ALL OTHERS"
became "Larceny"; "Clery Crime: ..." prefixes appeared). Grouping both formats
into the same buckets keeps trend lines comparable across the switch.

Rules are checked in order and the first match wins, so put specific patterns
(e.g. motor vehicle theft) before general ones (theft). An entry that lists
several offenses ("Drugs and Warrants") lands in the first group it matches.
"""
import re

CATEGORY_RULES = [
    # Placeholders and stray case numbers in the label field
    ("Not listed", r"^(not provided|not documented|n/p|unknown|pending)(\W|$)|^\d{10}$|^r\d{5}-\d{4}$"),
    ("Unfounded / error", r"unfounded|no bona ?fide|pulled (in )?error|no case"),
    ("Homicide", r"homicide|murder|manslaughter"),
    ("Sex offenses", r"sex|rape|fondl|indecent|incest|statutory|voyeur"),
    ("Dating/domestic violence & stalking", r"domestic|dating violence|stalk|\bdv\b"),
    ("Robbery", r"robbery"),
    ("DUI", r"\bdui\b|dwi|under the influence|extreme dui"),
    ("Assault", r"assault|assualt|aggravated|fight|endanger"),
    ("Burglary", r"burglar"),
    ("Motor vehicle theft", r"motor vehicle theft|vehicle theft|stolen vehicle|auto theft|\bgta\b"),
    ("Fraud", r"fraud|forg|identity theft|counterfeit|embezzl|scam"),
    ("Theft", r"larceny|laraceny|laceny|theft|shoplift|stolen|steal"),
    ("Weapons", r"weapon|firearm|gun|knife"),
    ("Liquor", r"liquor|alcohol|minors? in poss?ess?ion|\bmip\b|intox"),
    ("Drugs", r"drug|\bdug law|narcotic|marijuana|cannabis|paraphernalia|dangerous drug|controlled substance"),
    ("Criminal damage", r"criminal damage|vandal|graffiti|malicious mischief|arson"),
    ("Trespassing", r"trespass"),
    ("Disorderly conduct, threats & harassment", r"threat|harr?ass|intimidat|disorde?r?ly|hate|red tag"),
    ("Traffic & collisions", r"traffic|collisi?on|accident|hit and run|hit & run|moving viol|parking|motor vehicle laws"),
    ("Warrants", r"warr[ae]nt"),
    ("Lost & found property", r"found|lost"),
    ("Suspicious activity & disturbances", r"suspicious|disturbance|noise|loiter|prowl|vagrancy"),
    ("Welfare checks & assists", r"assis|welfare|medical|mental|sick|runaway|hazard|death|missing|information|"
                                 r"courtesy|escort|civil|animal|alarm|fire"),
]
_COMPILED = [(name, re.compile(pattern, re.I)) for name, pattern in CATEGORY_RULES]


def categorize(nature):
    for name, pattern in _COMPILED:
        if pattern.search(nature or ""):
            return name
    return "Other" if nature else "Not listed"


DISPOSITION_RULES = [
    # Placeholders, and dates typed into the disposition field
    ("Not listed", r"^(not provided|not documented|n/p|unknown)(\W|$)|^\d{1,2}/\d{1,2}/\d{2,4}$"),
    ("Unfounded", r"unfounded|pulled in error"),
    ("Arrest or citation", r"arrest|aresst|cite|citation|civil traffic|summons|booked|charges? filed"),
    ("Referral or diversion", r"referr|diversion|refer"),
    ("Open / pending", r"pending|investigation|further|open|active|suspend|inactive"),
    ("Closed", r"closed|cleared|exceptional|complete"),
]
_DISPOSITION = [(name, re.compile(pattern, re.I)) for name, pattern in DISPOSITION_RULES]


def disposition_group(disposition):
    for name, pattern in _DISPOSITION:
        if pattern.search(disposition or ""):
            return name
    return "Other" if disposition else "Not listed"


# "General Location" on each case page uses the Clery Act's geography terms but
# spells them many ways ("ON CAMPUS PROPERTY", "Clery Excluded", "Residence Hall-Cochise").
LOCATION_RULES = [
    ("On-campus student housing", r"student housing|residence hall"),
    ("On campus", r"^on campus"),
    ("Non-campus", r"non[- ]?campus"),
    ("Public property", r"public prop"),
    ("Clery excluded", r"exclude"),
]
_LOCATION = [(name, re.compile(pattern, re.I)) for name, pattern in LOCATION_RULES]


def location_group(general_location):
    value = (general_location or "").strip()
    if not value or value.lower() == "unknown":
        return "Not listed"
    for name, pattern in _LOCATION:
        if pattern.search(value):
            return name
    return "Other"
