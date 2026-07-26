export const GUIDE_BUILDER_UI_ENABLED =
  import.meta.env.MODE === "test"
  || import.meta.env.VITE_GUIDE_BUILDER_ENABLED === "true";
