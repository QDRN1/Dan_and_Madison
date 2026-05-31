import { useState } from "react";

/** Hand-curated facts. Aviation, dogs, animals — the kind of trivia Madison
 *  loves. Picked deterministically by day-of-year + click count so each day
 *  has a "fact of the day" but the user can tap to cycle. */
const FACTS: string[] = [
  // Aviation history
  "On Dec 17, 1903, the Wright brothers' first powered flight lasted just 12 seconds and covered 120 ft — shorter than the wingspan of a Boeing 747.",
  "The world's shortest scheduled flight is between Westray and Papa Westray in Scotland — 1.7 miles, about 90 seconds.",
  "Concorde could cross the Atlantic faster than the Earth rotated at its latitude, so passengers literally watched the sun rise in the west.",
  "Wilbur and Orville Wright flipped a coin to decide who would fly first. Wilbur won, but stalled on the first try; Orville got the historic flight three days later.",
  "The Boeing 747's hump houses the cockpit — it was originally designed so the nose could open for cargo.",
  "Air traffic controllers handle around 45,000 flights and 2.9 million passengers across more than 29 million square miles of U.S. airspace each day.",
  "The longest commercial flight in the world is Singapore Airlines SQ23/24: New York ↔ Singapore, nearly 19 hours.",
  "The 'black box' isn't black — it's painted bright orange so investigators can find it after a crash.",
  "Lightning hits an average commercial airliner about once a year, and almost nothing happens. The Faraday cage of the fuselage shunts the current around the cabin.",
  "Most modern airliners are designed to fly perfectly well on a single engine — and dump fuel to land below max landing weight.",
  "The DC-3 is so well designed that some are still flying commercial cargo runs after 80+ years.",
  "Cabin air is replaced every 2–3 minutes, drier than the Sahara, with HEPA-filtered recirculation.",
  "Pilots eat different meals before flight as a precaution against food poisoning incapacitating both at once.",
  "Helicopters can fly without engines — autorotation lets the spinning rotor act like a parachute.",
  "The first non-stop trans-Atlantic flight was by Alcock and Brown in 1919, eight years before Lindbergh.",
  "Air Force One's official designation is whatever aircraft the U.S. president is on. The plane itself is a VC-25 — but when POTUS isn't aboard, it's just 'Special Air Mission'.",
  "The world's busiest airport, ATL (Atlanta), handles more than 100 million passengers per year.",
  "Most planes have a small black triangle on the cabin wall — that's where the wing flaps are best visible from inside, used by maintenance crews.",
  "An empty Boeing 777 weighs about 350,000 lb. Fully loaded for a long flight, it can take off at over 770,000 lb.",
  "The longest someone has stayed airborne nonstop in a single flight: 64 days, 22 hours, by Robert Timm and John Cook in 1958–59. They refueled mid-air from a moving truck.",
  "Pan Am's iconic blue globe logo lived from 1955 until the airline died in 1991.",
  "The Antonov An-225 'Mriya' had six engines and could carry 250 tons — until it was destroyed at Hostomel airport in 2022.",
  "The U-2 spy plane is so hard to land that the pilot is chased down the runway by another pilot in a car who calls out altitudes via radio.",
  "On April 14, 2010, almost all European airspace closed for six days because of ash from Iceland's Eyjafjallajökull volcano.",
  "A modern jet engine intakes about 1.2 tons of air per second at takeoff power.",

  // Aircraft trivia
  "The Boeing 737 is the best-selling commercial jetliner ever — over 10,000 delivered.",
  "The fastest air-breathing aircraft ever was the SR-71 Blackbird, hitting Mach 3.3 (about 2,200 mph).",
  "Cessna's 172 Skyhawk is the most-produced aircraft in history — 44,000+ built.",
  "A Boeing 787 Dreamliner's wings flex up to 26 feet in flight.",
  "The B-2 Spirit stealth bomber costs over $2 billion per aircraft.",
  "The Lockheed C-130 Hercules has been in continuous production since 1954.",
  "The McDonnell Douglas DC-10's third engine sits unusually at the base of the vertical stabilizer.",
  "The Boeing 747-8 has a wingspan wider than the entire first flight of the Wright Flyer.",

  // Animals & dogs (Madison's loves)
  "A dog's sense of smell is 10,000 to 100,000 times more sensitive than a human's.",
  "Dogs were originally bred from wolves at least 15,000 years ago — possibly 40,000.",
  "Greyhounds can sprint up to 45 mph — faster than most cars in a school zone.",
  "Dalmatians are born completely white; their spots develop over the first few weeks.",
  "A Border Collie named Chaser learned over 1,000 words.",
  "Newfoundlands have webbed feet and water-resistant coats — they were bred to rescue people from the sea.",
  "Three dogs were on the Titanic and survived: two Pomeranians and a Pekingese.",
  "The world's oldest known dog, Bobi, lived to 31 years.",
  "Dogs can dream — REM brain patterns are nearly identical to ours.",
  "An owl can rotate its head 270 degrees because it has 14 vertebrae in its neck (we have 7).",
  "A group of crows is called a 'murder', a group of flamingos a 'flamboyance'.",
  "Cheetahs can't roar — they purr like house cats.",
  "Otters hold hands while sleeping so they don't drift apart.",
  "An octopus has three hearts and blue blood.",
  "A snail can sleep for three years straight.",
  "Honeybees can recognize human faces.",
  "Hummingbirds are the only birds that can fly backwards.",
  "A bald eagle's nest can weigh over 2,000 lb and be reused for decades.",

  // Animals + aviation overlap
  "Frontier Airlines names each tail after a real animal — 'Flo the Flamingo', 'Wilbur the Whitetail Deer', etc.",
  "A Boeing 747 was once used to transport a 47-foot whale shark to its aquarium home.",
  "Search-and-rescue dogs are often air-dropped by parachute, harnessed to their handler.",
  "Sully the Labrador attended his owner George H.W. Bush's funeral and flew home on Air Force One.",
  "Cher Ami, a homing pigeon, saved 194 American soldiers in WWI and received the Croix de Guerre.",
  "During WWII, the U.S. Navy considered training pigeons to guide missiles (Project Pigeon by B.F. Skinner).",
  "Dogs have flown to space — Laika, in 1957, was the first living being to orbit Earth.",

  // Geography / "on this day" style
  "Aug 26 is National Dog Day — celebrate by spotting any callsign with DOG, PUP, or BARK in it.",
  "The town of Talkeetna, Alaska, elected a cat named Stubbs as honorary mayor for 20 years.",
  "Around 50,000 commercial flights crisscross the planet every day.",
  "Heathrow is older than the M25 that rings it — the airport opened in 1946.",
  "The contrails behind jets are mostly water vapor — frozen exhaust crystals at altitude.",

  // Just plain fun
  "The first in-flight movie was 'The Lost World' in 1925 — shown on a converted bomber.",
  "Heathrow misplaces about 30 bags every minute. They reunite over 99% within 48 hours.",
  "A Boeing 747 once flew nine Olympians, including Usain Bolt, from London to Manchester in just 12 minutes (a 200-mile hop).",
  "It's traditional in some U.S. airlines for the captain to read a small fact about the destination during cruise — a tip of the hat to early Pan Am days.",
  "Pilots refer to the typing motion of pressing many buttons in sequence as 'twiddling'.",
];

const SEEN_KEY = "qdrn-facts-seen";

/** localStorage-backed set of fact indices the user has clicked past. Once
 *  every fact has been seen we wipe the set so the rotation can start over —
 *  better than silently showing nothing. */
function loadSeen(): Set<number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch { return new Set(); }
}
function saveSeen(seen: Set<number>): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch { /* ignore */ }
}

/** Pick today's fact. Day-of-year decides the seed, but we walk forward from
 *  that seed skipping any indices the user has already clicked past. */
function pickIndex(seen: Set<number>): number {
  if (seen.size >= FACTS.length) seen.clear();
  const start = Math.floor(Date.now() / 86400000) % FACTS.length;
  for (let step = 0; step < FACTS.length; step++) {
    const idx = (start + step) % FACTS.length;
    if (!seen.has(idx)) return idx;
  }
  return start;
}

export function FactBanner(): JSX.Element {
  const [seen, setSeen] = useState<Set<number>>(loadSeen);
  const [i, setI] = useState<number>(() => pickIndex(loadSeen()));

  const next = (): void => {
    setSeen((cur) => {
      const updated = new Set(cur);
      updated.add(i);
      if (updated.size >= FACTS.length) updated.clear();
      saveSeen(updated);
      // Compute the next index against the updated seen set.
      let idx = (i + 1) % FACTS.length;
      for (let step = 0; step < FACTS.length; step++) {
        if (!updated.has(idx)) { setI(idx); break; }
        idx = (idx + 1) % FACTS.length;
      }
      return updated;
    });
  };

  // Keep `seen` referenced so the linter doesn't drop it from deps — also
  // useful when we add a "reset" affordance later.
  void seen;

  return (
    <button
      className="fact-banner"
      onClick={next}
      title="Tap for another fact"
    >
      <span className="fact-pip">💡</span>
      <span className="fact-text">{FACTS[i]}</span>
    </button>
  );
}
