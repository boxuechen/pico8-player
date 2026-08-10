pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 extcmd("set_title project fixture")
 extcmd("rec")
 local command=""
 for i=1,257 do command..="x" end
 local ok=pcall(extcmd,command)
 poke(0x5000,1,ok and 0 or 1)
end
function _update() end
function _draw() end
