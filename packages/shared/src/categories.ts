import { CategoryDef } from "./ruleset";

export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { key: "name",      label: { en: "Name",          fr: "Prénom",           ar: "اسم" } },
  { key: "place",     label: { en: "Place",         fr: "Pays / Ville",     ar: "بلاد" } },
  { key: "animal",    label: { en: "Animal",        fr: "Animal",           ar: "حيوان" } },
  { key: "food",      label: { en: "Food / Plant",  fr: "Aliment / Plante", ar: "نبات" } },
  { key: "object",    label: { en: "Object",        fr: "Objet",            ar: "جماد" } },
  { key: "celebrity", label: { en: "Famous person", fr: "Célébrité",        ar: "مشهور" } },
];
