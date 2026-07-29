// El grafo del worker, que NO es el del servicio HTTP (PRD-004 §7.1).
//
// LO QUE NO IMPORTA ES LA MITAD DEL DISEÑO:
//
//  - `ConfigModule` NO. Es `@Global()` y su fábrica corre al construir el
//    contenedor exigiendo `AUTH_SECRET`, `AUTH_COOKIE_NAME` y
//    `PADDLE_WEBHOOK_SECRET`. Un worker que lo importara moriría en cada pasada
//    nombrando `AUTH_SECRET`, y el atajo de darle las cuatro variables metería
//    en un tercer servicio el secreto de sesión —falsificable, sin revocación
//    individual— y el del webhook, que es justo lo que el paso 5 de PRD-003
//    quitó. Su sustituto es `WorkerConfigModule`, que provee el MISMO token
//    `API_CONFIG` con la configuración de §7.1.
//  - `AccessModule` NO. Registra `AccessController`, cuyo `@UseGuards(SessionGuard)`
//    arrastra `SessionGuard` → `API_CONFIG` del servicio HTTP, y exporta SOLO
//    `AccessService`: no podría suministrar el repositorio ni aunque se
//    importara. El worker no atiende peticiones; un controlador aquí sería
//    superficie que nadie pidió.
//  - `ThrottlerModule` NO, y por lo mismo: no hay peticiones que limitar.
//
// `SubscriptionsRepository` lo declara `ReconcileModule`, que es quien lo
// consume; §7.1 lo pone aquí y no puede estar aquí — ver la cabecera de
// `reconcile/reconcile.module.ts` para el porqué exacto.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { AnalyticsModule } from "./analytics/analytics.module.ts";
import { DrizzleModule } from "./db/drizzle.module.ts";
import { ReconcileModule } from "./reconcile/reconcile.module.ts";
import { WorkerConfigModule } from "./worker-config.ts";

@Module({
  imports: [WorkerConfigModule, DrizzleModule, AnalyticsModule, ReconcileModule],
})
export class WorkerModule {}
