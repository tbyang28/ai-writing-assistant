import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import type { AuthedRequest } from "../core/current-user.decorator";
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header) return true;
    if (!header.startsWith("Bearer ") || !header.slice(7).trim())
      throw new UnauthorizedException("Invalid token");
    try {
      const payload = await this.auth.verifyAccessToken(header.slice(7).trim());
      const user = await this.auth.getUserById(payload.sub as string);
      if (!user) throw new UnauthorizedException("User not found");
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }
}
