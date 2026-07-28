// Módulo global de configuración. La fábrica se ejecuta al construir el
// contenedor de DI, así que una variable ausente tumba el arranque —tanto el de
// producción como el de `Test.createTestingModule`— en vez de aparecer como un
// 500 en la primera petición (goal 5, §9 fila 3).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Global, Module } from "@nestjs/common";

import { API_CONFIG, resolveApiConfig } from "./config.ts";

@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: () => resolveApiConfig() }],
  exports: [API_CONFIG],
})
export class ConfigModule {}
