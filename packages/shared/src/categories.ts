import { CategoryDef } from "./ruleset";

/**
 * `aiRule` is the membership test handed verbatim to the AI referee. Keep each one
 * tight and exclusive — vague rules are exactly how "sandwich" scores as an object.
 * `examples` are shown as input placeholders so players learn what the field wants.
 */
export const DEFAULT_CATEGORIES: CategoryDef[] = [
  {
    key: "name",
    icon: "🧑",
    // a name that is real somewhere is real; the room often knows what the referee can't
    humanReviewable: true,
    label: { en: "Name", fr: "Prénom", ar: "اسم" },
    aiRule:
      "a given name (first name) that real people are actually called, in any culture. " +
      "Reject invented names, surnames on their own, and common nouns used as names.",
  },
  {
    key: "place",
    icon: "🌍",
    label: { en: "Place", fr: "Pays / Ville", ar: "بلاد" },
    aiRule:
      "a real geographic place: country, city, town, region, state, river, mountain, island or sea. " +
      "Reject invented places and fictional locations.",
  },
  {
    key: "animal",
    icon: "🐘",
    label: { en: "Animal", fr: "Animal", ar: "حيوان" },
    aiRule:
      "a real animal — mammal, bird, fish, insect, reptile, amphibian or other creature. " +
      "Reject plants, mythical creatures, objects and animal body parts.",
  },
  {
    key: "food",
    icon: "🍎",
    label: { en: "Food / Plant", fr: "Aliment / Plante", ar: "نبات" },
    aiRule:
      "something edible or a plant: a dish, drink, fruit, vegetable, spice, grain, tree or flower. " +
      "Reject inedible objects and animals that are not served as a named dish.",
  },
  {
    key: "object",
    icon: "🪑",
    label: { en: "Object", fr: "Objet", ar: "جماد" },
    aiRule:
      "an inanimate physical thing you could point at — a tool, furniture, vehicle, garment, device or natural object. " +
      "Reject foods, drinks, plants, animals, people, places and abstract ideas.",
  },
  {
    key: "celebrity",
    icon: "⭐",
    // regional fame is precisely what the players know and the referee may not
    humanReviewable: true,
    label: { en: "Famous person", fr: "Célébrité", ar: "مشهور" },
    aiRule:
      "a real, publicly known person — living or historical — such as an actor, musician, athlete, " +
      "politician, scientist, writer or leader. Reject fictional characters and people nobody outside " +
      "a private circle would know. Regional and non-Western fame counts fully.",
  },
];
