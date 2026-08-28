# Verizon Connect Reveal — GPS Webhook Integration Guide

Reference notes for implementing the GPS webhook receiver at `tms.balkania.ie`.

---

## 1. Endpoint Requirements

- **HTTPS only** — TLS 1.2 or later. No certificate warnings allowed (no self-signed/expired certs).
- **Port 443** — must be hosted on the standard HTTPS port.
- **Hostname restrictions** — must NOT contain an underscore.
- **Basic Auth credentials** — username/password must avoid these characters: `/ \ ' " : @` and other escape-sequence-triggering chars. Stick to alphanumerics (and `-`/`_` if needed).
- **Content-Type** — endpoint must accept `text/plain; charset=UTF-8` at the transport level (even though the body is JSON text).

---

## 2. Two Message Types

SNS sends two message types, distinguished by the `x-amz-sns-message-type` header:

| Header value | Purpose |
|---|---|
| `SubscriptionConfirmation` | One-time setup — confirms the endpoint |
| `Notification` | Ongoing GPS plot data |

---

## 3. Authentication Flow (Basic Auth over SNS)

1. SNS sends the **first** `SubscriptionConfirmation` request **without** credentials.
2. Your endpoint must respond:
   ```
   HTTP/1.1 401 Unauthorized
   WWW-Authenticate: Basic
   ```
3. SNS then retries the **same** request, this time including:
   ```
   Authorization: Basic <base64(username:password)>
   ```
4. Your endpoint validates the credentials and processes the request normally.

**Important:** Return immediately after writing the 401 response — don't fall through to normal request processing on the unauthenticated branch.

---

## 4. Step 1 — Subscription Confirmation

**Example request:**
```
POST / HTTP/1.1
x-amz-sns-message-type: SubscriptionConfirmation
x-amz-sns-message-id: 165545c9-2a5c-472c-8df2-7ff2be2b3b1b
x-amz-sns-topic-arn: arn:aws:sns:us-west-2:123456789012:MyTopic
Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==
Content-Type: text/plain; charset=UTF-8
```

```json
{
  "Type": "SubscriptionConfirmation",
  "MessageId": "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
  "Token": "2336412f37...",
  "TopicArn": "arn:aws:sns:us-west-2:123456789012:MyTopic",
  "Message": "You have chosen to subscribe...",
  "SubscribeURL": "https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=...&Token=...",
  "Timestamp": "2012-04-26T20:45:04.751Z",
  "SignatureVersion": "1",
  "Signature": "EXAMPLE...",
  "SigningCertURL": "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-....pem"
}
```

**What your endpoint must do:**
- Parse the raw text body as JSON.
- Extract `SubscribeURL`.
- Make an **outbound GET request** to `SubscribeURL` to complete the subscription.
- Return `200 OK`.

**⚠️ Token expiration:** The `SubscribeURL` / `Token` expires after **3 days**. If you don't confirm within that window, the subscription attempt dies — there is no way to "re-confirm" it. You must resubmit the endpoint in Reveal to trigger a brand-new `SubscriptionConfirmation` message with a fresh token.

- No GPS plot data (`Notification` messages) will be sent until the subscription is confirmed.

---

## 5. Step 2 — Notification Messages (GPS Plot Data)

**Example request:**
```
POST / HTTP/1.1
x-amz-sns-message-type: Notification
x-amz-sns-message-id: 22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324
x-amz-sns-subscription-arn: arn:aws:sns:us-west-2:123456789012:MyTopic:c9135db0-26c4-47ec-8998-413945fb5a96
Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==
Content-Type: text/plain; charset=UTF-8
```

```json
{
  "specversion": "1.0",
  "id": "813af552-c049-43d9-b978-159a1857f43e",
  "type": "com.verizonconnect.integrations.vehicle.position.updated",
  "source": "https://verizonconnect.com/integrations/channels/push",
  "time": "2022-10-05T09:45:30.3799855Z",
  "subject": "vehicle.esn.342434234",
  "datacontenttype": "application/json",
  "data": {
    "sequenceId": 999000000,
    "updateUTC": "2022-10-21T13:34:39",
    "deviceTimeZoneOffset": 2,
    "deviceTimeZoneUseDST": true,
    "displayState": "Idle",
    "isPrivate": false,
    "speedKmph": 85,
    "directionDegrees": 280,
    "heading": "North",
    "deltaDistanceKm": 0.354,
    "odometerKm": 120045,
    "totalEngineMinutes": 1380,
    "idleTimeMinutes": 4,
    "latitude": -6.3752626,
    "longitude": 53.2979679,
    "deltaTimeInSec": 90,
    "sensorBits": 65,
    "sensorValues": ["Boom Stow 1-ON", "Boom Stow 2-OFF", "Boom Stow 3-OFF", "Boom Stow 4-OFF"],
    "vehicle": {
      "number": "V242342",
      "name": "Truck2324",
      "vin": "Z232SD43FAS",
      "esn": 342434234
    },
    "address": {
      "addressLine1": "Atrium Building, Blackthorn Road",
      "addressLine2": "Sandyford Business Park",
      "locality": "Dublin",
      "postalCode": "D18 F5X2",
      "administrativeArea": "Dublin",
      "country": "IRL"
    },
    "driver": {
      "driverKeyFobId": 234423678,
      "driverNumber": "D234",
      "driverFirstName": "Tim",
      "driverLastName": "Daruch"
    }
  }
}
```

### Content-Type nuance (important)

- Transport-level `Content-Type` header is **always** `text/plain; charset=UTF-8` — you must read the body as raw text, not rely on framework auto-JSON parsing.
- The `datacontenttype` field **inside** the JSON body (`"datacontenttype": "application/json"`) describes only the `data` property — it tells you that nested member should be treated/deserialized as JSON.
- Flow: **read raw text → `JSON.parse()` the whole body → access `.data` directly** (no double-encoding, no separate unwrap step needed).

### Field Reference

| Field | Notes |
|---|---|
| `vehicle.number` | Vehicle number |
| `vehicle.name` | Display name in Reveal |
| `vehicle.vin` | VIN |
| `vehicle.esn` | Unique vehicle identifier — mandatory, use as your join key |
| `sequenceId` | Unique identifier per plot — **use for dedup/idempotency and ordering** |
| `updateUTC` | Timestamp of the plot (UTC) |
| `deviceTimeZoneOffset` | Device's timezone offset from UTC |
| `deviceTimeZoneUseDST` | Whether DST is observed (US accounts default `true`) |
| `displayState` | Enum: `0` Coverage, `1` Moving, `2` Stop, `3` Towing, `4` Idle, `5` Panic, `6` Privacy |
| `isPrivate` | If `true` → address, coordinates, and speed will be **null/absent**. Handle gracefully. |
| `speedKmph` | km/h |
| `directionDegrees` | Compass degrees |
| `heading` | North / North East / East / South East / South / South West / West / North West / Unknown |
| `deltaDistanceKm` | Distance since last plot (defaults to 0) |
| `odometerKm` | Cumulative odometer |
| `totalEngineMinutes` | Lifetime engine-on minutes |
| `idleTimeMinutes` | Continuous idle time |
| `deltaTimeInSec` | Time since last plot (defaults NULL if none) |
| `address.*` | addressLine1/2, locality, postalCode, administrativeArea, country |
| `latitude` / `longitude` | Coordinates |
| `driver.driverKeyFobId` | Hex value of driver's key fob |
| `driver.driverNumber` | Unique driver ID in Reveal — NULL if unassigned or no number set |
| `driver.driverFirstName` / `driver.driverLastName` | NULL if unassigned |
| `sensorBits` | Combined decimal value of all sensor flags |
| `sensorValues` | Variable-length array of active sensor names — don't assume fixed shape |

---

## 6. Delivery / Retry Configuration

- **Response deadline: 15 seconds.** You must return `200 OK` within this window.
- **Only `200` counts as success.** Any other status code = failed delivery.
- **Retries:** up to **2 retries**, 60 seconds apart, then the plot is **permanently discarded**.
- **Implication:** Ack fast, process async. Don't do heavy synchronous work (DB writes, geocoding, enrichment) in the request path — push to a queue/worker and return `200` immediately.

```
POST /webhook/gps
  authenticate()               // 401 + WWW-Authenticate if missing/invalid
  payload = JSON.parse(raw_body)
  queue.push(payload)          // hand off immediately
  return 200                    // ack well under 15s
```

---

## 7. Troubleshooting

### Not receiving the confirmation message
1. **Check public reachability** from an external machine (not your own network):
   ```bash
   curl -X POST https://tms.balkania.ie/your-webhook-path \
     -H "Content-Type: text/plain; charset=UTF-8" \
     --data '{"x":"y"}' -v
   ```
   Expect `200 OK`. If unreachable, Reveal will error with `Unreachable Endpoint` when you try to subscribe.
2. Confirm your endpoint reads `x-amz-sns-message-type` header correctly.
3. Confirm the 401 + `WWW-Authenticate: Basic` response is correctly implemented (RFC 2617 compliant).

### Missing GPS plot data
1. Confirm the subscription was actually completed (see §4).
2. Confirm you're checking for `x-amz-sns-message-type: Notification`.
3. Confirm your endpoint accepts `Content-Type: text/plain; charset=UTF-8`.

### AWS API Gateway
If fronted by API Gateway rather than hitting the app server directly, you must ensure Unauthorized (401) responses — including the `WWW-Authenticate` header — are correctly mapped through Gateway, since Gateway can strip/rewrite headers unless configured explicitly.

---

## 8. Reference Code (C# / ASP.NET, from VZC docs)

### Authentication Middleware
```csharp
public async Task Invoke(HttpContext context)
{
    var authHeader = context.Request.Headers.Get("Authorization");
    if (authHeader != null && authHeader.StartsWith("basic", StringComparison.OrdinalIgnoreCase))
    {
        var token = authHeader.Substring("Basic ".Length).Trim();
        var credentialstring = Encoding.UTF8.GetString(Convert.FromBase64String(token));
        var credentials = credentialstring.Split(':');
        if (credentials[0] == "admin" && credentials[1] == "password")
        {
            var claims = new[] { new Claim("name", credentials[0]), new Claim(ClaimTypes.Role, "Admin") };
            var identity = new ClaimsIdentity(claims, "Basic");
            context.User = new ClaimsPrincipal(identity);
        }
    }
    else
    {
        context.Response.StatusCode = 401;
        context.Response.Headers.Set("WWW-Authenticate", "Basic");
        return; // IMPORTANT: don't fall through to _next() on the unauthenticated branch
    }
    await _next(context);
}
```

### Controller — Process SNS / GPS Message
```csharp
[HttpPost]
[Consumes(MediaTypeNames.Text.Plain)]
public async Task<IActionResult> ProcessRequest()
{
    JsonSerializerOptions options = new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true
    };
    try
    {
        string requestMessage;
        using (StreamReader reader = new StreamReader(Request.Body, Encoding.UTF8))
        {
            requestMessage = await reader.ReadToEndAsync();
        }

        switch (Request.Headers["x-amz-sns-message-type"])
        {
            case "SubscriptionConfirmation":
                var snsMessage = JsonSerializer.Deserialize<SnsMessageModel>(requestMessage);
                await ConfirmSubscription(snsMessage.SubscribeURL);
                break;

            case "Notification":
                var vzcGpsPlotMessage = JsonSerializer.Deserialize<VzcCloudEvent>(requestMessage, options);
                await ProcessVzcGpsMessage(vzcGpsPlotMessage.Data);
                break;

            default:
                // handle unexpected type
                break;
        }
        return Ok();
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Webhook processing failed");
        return StatusCode(StatusCodes.Status500InternalServerError, ex.Message);
    }
}

private async Task<bool> ConfirmSubscription(string subscriptionUrl)
{
    using var httpClient = new HttpClient();
    var response = await httpClient.SendAsync(new HttpRequestMessage(HttpMethod.Get, new Uri(subscriptionUrl)));
    return response.IsSuccessStatusCode;
}

private Task ProcessVzcGpsMessage(GpsPlotMessage gpsData)
{
    // Push to queue for async processing — don't block the 15s response window
    throw new NotImplementedException();
}
```

### Models
```csharp
public class VzcCloudEvent
{
    public string Type { get; set; }
    public string SpecVersion { get; set; }
    public string Source { get; set; }
    public string Subject { get; set; }
    public DateTime Time { get; set; }
    public GpsPlotMessage Data { get; set; }
}

public class GpsPlotMessage
{
    public int SequenceId { get; set; }
    public VehicleInfo Vehicle { get; set; }
    public DateTime UpdateUTC { get; set; }
    public float DeviceTimeZoneOffset { get; set; }
    public string DisplayState { get; set; }
    public bool IsPrivate { get; set; }
    public float SpeedKmph { get; set; }
    public int DirectionDegrees { get; set; }
    public string Heading { get; set; }
    public float DeltaDistanceKm { get; set; }
    public double OdometerKm { get; set; }
    public int TotalEngineMinutes { get; set; }
    public int IdleTimeMinutes { get; set; }
    public AddressInfo Address { get; set; }
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public DriverInfo Driver { get; set; }
    public float DeltaTimeInSec { get; set; }
    public int SensorBits { get; set; }
    public string[] SensorValues { get; set; }
}

public class VehicleInfo
{
    public string Number { get; set; }
    public string Name { get; set; }
    public string VIN { get; set; }
    public long? ESN { get; set; }
}

public class AddressInfo
{
    public string AddressLine1 { get; set; }
    public string AddressLine2 { get; set; }
    public string Locality { get; set; }
    public string PostalCode { get; set; }
    public string AdministrativeArea { get; set; }
    public string Country { get; set; }
}

public class DriverInfo
{
    public object DriverKeyFobId { get; set; }
    public string DriverLastName { get; set; }
    public string DriverFirstName { get; set; }
    public string DriverNumber { get; set; }
}
```

---

## 9. Implementation Checklist for `tms.balkania.ie`

- [ ] Endpoint publicly reachable over HTTPS on port 443, valid TLS 1.2+ cert
- [ ] Hostname has no underscore
- [ ] Basic Auth credentials avoid restricted characters
- [ ] Endpoint reads raw body as `text/plain`, then `JSON.parse()`s it
- [ ] Unauthenticated request → `401` + `WWW-Authenticate: Basic` (with hard `return`)
- [ ] Authenticated `SubscriptionConfirmation` → GET the `SubscribeURL` → `200`
- [ ] `Notification` messages → dedup via `sequenceId` → queue for async processing → `200` within 15s
- [ ] Handle `isPrivate: true` (null address/coords/speed) without erroring
- [ ] Handle NULL driver fields when unassigned
- [ ] External `curl` reachability test passes before resubmitting in Reveal
- [ ] Resubmit endpoint in Reveal within 3 days of any change (token expiry)