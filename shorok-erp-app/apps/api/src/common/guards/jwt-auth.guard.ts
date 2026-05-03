import { ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { TokenExpiredError, InvalidCredentialsError } from "../errors/api-errors";

/**
 * Wraps Passport's JWT guard so we can:
 *  - bypass authentication on @Public() routes
 *  - convert Passport rejections into our typed ApiError shape
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser>(
    err: unknown,
    user: TUser,
    info: { name?: string; message?: string } | undefined,
  ): TUser {
    if (err) throw err;
    if (!user) {
      if (info?.name === "TokenExpiredError") throw new TokenExpiredError();
      throw new InvalidCredentialsError();
    }
    return user;
  }
}
