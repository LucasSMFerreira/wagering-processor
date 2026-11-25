import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Extension point for authentication. It lets everything through on purpose:
 * see ARCHITECTURE.md, "Authentication". A real implementation would validate an
 * OIDC access token issued by an external IdP (Keycloak/Zitadel, client credentials
 * per provider) and check that the token's provider matches body.providerId.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}