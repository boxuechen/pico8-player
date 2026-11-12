pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-authored phase 4c nested-coroutine budget containment probe
function _init()
 local co=cocreate(function()
  while true do end
 end)
 coresume(co)
 poke(0x5200,0xff)
end

function _update60() end
function _draw() end
