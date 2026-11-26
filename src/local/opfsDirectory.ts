/**
 * The OPFS directory the database worker keeps its file in. It sits in a module of its own
 * so web code and its tests can name it without importing the worker, which would pull the
 * whole Worker-typed app (`src/api`) into the DOM-typed web project.
 */
export const OPFS_DIRECTORY = "vemi-local";
