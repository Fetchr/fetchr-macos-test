/** An error the client caused: the API answers it with `status` and `message`.
 *  Anything else becomes a bare 500, so internals never reach the response. */
export class ClientError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
