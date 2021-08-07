import { createConnection, Socket } from 'net'
import { delay, logDebug, logError } from './util'

class ConnectionManager {
  private socket?: Socket
  private previousRequestId = 0
  private previousRequest: Promise<unknown> = Promise.resolve()

  constructor(private host: string, private port: number) {}

  private socketPromise?: Promise<Socket>

  private openSocket() {
    if (this.socketPromise) {
      return this.socketPromise
    }

    this.socketPromise = new Promise<Socket>((resolve, reject) => {
      const socket: Socket = createConnection(
        {
          host: this.host,
          port: this.port,
        },
        () => {
          resolve(socket)
        }
      )
      socket.on('error', (e) => {
        logDebug('Socket Error')
        logDebug(e)
        reject(e)
      })
      socket.on('close', () => {
        logDebug('Socket Closed')
        this.socket = undefined
      })
      this.socket = socket
    })

    return this.socketPromise
  }

  send<T = any>(payload: Record<string, unknown>) {
    const request = this.previousRequest
      .catch(() => null)
      .then(async () => {
        const socket = await this.openSocket(),
          requestId = this.previousRequestId++

        return new Promise<T>((resolve, reject) => {
          function responseHandler(data: Buffer) {
            try {
              const response = JSON.parse(data.toString())
              if (response.id === requestId) {
                resolve(response)
              }
            } catch (e) {
              logError(e)
              reject(e)
            } finally {
              // eslint-disable-next-line no-use-before-define
              cleanUp()
            }
          }
          function cleanUp() {
            socket.off('data', responseHandler)
          }

          socket.on('data', responseHandler)

          setTimeout(() => {
            cleanUp()
            reject(new Error('Failed to send command after 5 seconds'))
          }, 5000)

          socket.write(
            JSON.stringify({
              id: requestId,
              ...payload,
            }),
            (error) => {
              if (error) {
                reject(error)
              }
            }
          )
        })
      })

    this.previousRequest = request
    return request
  }
}

interface JsonRpcResponse<T = any> {
  jsonrpc: '2.0'
  result: T
}

export interface ChannelInfo {
  targetID: string
  name: string
  type: number
}

export function splitTargetId(targetId: string) {
  const [deviceId, channelId] = targetId.split('.')

  return {
    deviceId,
    channelId: +channelId,
  }
}

export class Channel {
  public readonly deviceId: string
  public readonly channelId: number

  get name() {
    return this.info.name
  }

  get targetId() {
    return this.info.targetID
  }

  // eslint-disable-next-line no-use-before-define
  constructor(public readonly info: ChannelInfo, public myLink: MyLink) {
    const { deviceId, channelId } = splitTargetId(info.targetID)
    this.deviceId = deviceId
    this.channelId = channelId
  }

  down() {
    return this.myLink.send<boolean>(this.targetId, 'mylink.move.down')
  }

  stop() {
    return this.myLink.send<boolean>(this.targetId, 'mylink.move.stop')
  }

  up() {
    return this.myLink.send<boolean>(this.targetId, 'mylink.move.up')
  }

  getInfo() {
    return this.myLink.send<Pick<ChannelInfo, 'name' | 'type'>>(
      this.targetId,
      'mylink.status.info'
    )
  }
}

export class MyLink {
  private connectionManager = new ConnectionManager(this.host, this.port)

  constructor(
    private systemID: string,
    private host: string,
    private port = 44100
  ) {}

  async getChannels(): Promise<Channel[]> {
    try {
      const channelInfos = await this.send<ChannelInfo[]>(
        '*.*',
        'mylink.status.info'
      )

      return channelInfos.map((info) => new Channel(info, this))
    } catch (e) {
      logError('Failed to get channels')
      logError(e.message)

      await delay(5000)
      return this.getChannels()
    }
  }

  async send<T = any>(targetID: string | undefined, method: string) {
    const request = {
        method,
        params: {
          auth: this.systemID,
          targetID,
        },
      },
      { result } = await this.connectionManager.send<JsonRpcResponse<T>>(
        request
      )

    return result
  }
}
