"use server";

import { signOut } from "@/auth";

// Cierra la sesión del estudiante y lo manda a la pantalla de login.
// Es una server action: se invoca desde el <form> del botón "Salir".
export async function logout() {
  await signOut({ redirectTo: "/signin" });
}
