<?xml version="1.0" encoding="UTF-8"?>
<!-- IIS front door for devmon: ARR reverse proxy to Node on 127.0.0.1:3000, websockets on,
     HTTPS forced, static files served by Node (cached). Placed in the site's physical path. -->
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Force HTTPS" stopProcessing="true">
          <match url="(.*)" />
          <conditions><add input="{HTTPS}" pattern="off" ignoreCase="true" /></conditions>
          <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
        </rule>
        <rule name="Proxy to Node" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <webSocket enabled="true" />
    <security>
      <requestFiltering><requestLimits maxAllowedContentLength="10485760" /></requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders>
        <remove name="X-Powered-By" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
